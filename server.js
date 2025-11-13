// server.js - خادم Node.js لتحميل فيديوهات اليوتيوب
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// إعدادات الخادم
const PORT = process.env.PORT || 3001;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// التأكد من وجود مجلد التحميلات
async function ensureDownloadsDir() {
    try {
        await fs.access(DOWNLOADS_DIR);
    } catch {
        await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
        console.log('تم إنشاء مجلد التحميلات');
    }
}

// دالة للتحقق من وجود yt-dlp
function checkYtDlp() {
    return new Promise((resolve) => {
        exec('yt-dlp --version', (error) => {
            resolve(!error);
        });
    });
}

// استخراج معرف الفيديو من رابط اليوتيوب
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// API لجلب معلومات الفيديو
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'رابط الفيديو مطلوب' });
        }

        const videoId = extractVideoId(url);
        if (!videoId) {
            return res.status(400).json({ error: 'رابط اليوتيوب غير صحيح' });
        }

        // التحقق من وجود yt-dlp
        const ytDlpExists = await checkYtDlp();
        if (!ytDlpExists) {
            return res.status(500).json({ error: 'yt-dlp غير مثبت على الخادم' });
        }

        // استخدام yt-dlp لجلب معلومات الفيديو
        const command = `yt-dlp -j "${url}"`;
        
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('خطأ في جلب معلومات الفيديو:', stderr);
                return res.status(500).json({ error: 'فشل في جلب معلومات الفيديو' });
            }

            try {
                const videoInfo = JSON.parse(stdout);
                
                // استخراج الصيغ المتاحة
                const formats = videoInfo.formats || [];
                const videoFormats = formats.filter(f => 
                    f.vcodec && f.vcodec !== 'none' && f.ext === 'mp4'
                );

                // ترتيب الجودات
                const qualityMap = {
                    '144': { label: 'أدنى جودة (144p)', priority: 1 },
                    '240': { label: 'جودة ضعيفة (240p)', priority: 2 },
                    '360': { label: 'جودة منخفضة (360p)', priority: 3 },
                    '480': { label: 'جودة متوسطة (480p)', priority: 4 },
                    '720': { label: 'HD (720p)', priority: 5 },
                    '1080': { label: 'Full HD (1080p)', priority: 6 },
                    '1440': { label: '2K (1440p)', priority: 7 },
                    '2160': { label: '4K (2160p)', priority: 8 }
                };

                const availableQualities = [];
                const seenQualities = new Set();

                videoFormats.forEach(format => {
                    const height = format.height;
                    if (height && qualityMap[height] && !seenQualities.has(height)) {
                        seenQualities.add(height);
                        availableQualities.push({
                            quality: height + 'p',
                            label: qualityMap[height].label,
                            size: format.filesize ? `~${Math.round(format.filesize / 1024 / 1024)} MB` : 'غير محدد',
                            formatId: format.format_id,
                            priority: qualityMap[height].priority
                        });
                    }
                });

                // ترتيب حسب الأولوية
                availableQualities.sort((a, b) => b.priority - a.priority);

                res.json({
                    videoId: videoInfo.id,
                    title: videoInfo.title,
                    thumbnail: videoInfo.thumbnail,
                    duration: videoInfo.duration,
                    uploader: videoInfo.uploader,
                    view_count: videoInfo.view_count,
                    qualities: availableQualities
                });

            } catch (parseError) {
                console.error('خطأ في تحليل معلومات الفيديو:', parseError);
                res.status(500).json({ error: 'فشل في تحليل معلومات الفيديو' });
            }
        });

    } catch (error) {
        console.error('خطأ عام:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// API لتحميل الفيديو
app.post('/api/download', async (req, res) => {
    try {
        const { url, quality } = req.body;
        
        if (!url || !quality) {
            return res.status(400).json({ error: 'رابط الفيديو والجودة مطلوبان' });
        }

        const videoId = extractVideoId(url);
        if (!videoId) {
            return res.status(400).json({ error: 'رابط اليوتيوب غير صحيح' });
        }

        const ytDlpExists = await checkYtDlp();
        if (!ytDlpExists) {
            return res.status(500).json({ error: 'yt-dlp غير مثبت على الخادم' });
        }

        // اسم الملف
        const timestamp = Date.now();
        const filename = `${videoId}_${quality}_${timestamp}.%(ext)s`;
        const outputPath = path.join(DOWNLOADS_DIR, filename);

        // أمر التحميل
        const downloadCommand = `yt-dlp -f "best[height<=${quality.replace('p', '')}][ext=mp4]" -o "${outputPath}" "${url}"`;
        
        console.log(`بدء تحميل الفيديو: ${videoId} بجودة ${quality}`);

        exec(downloadCommand, { timeout: 300000 }, async (error, stdout, stderr) => {
            if (error) {
                console.error('خطأ في التحميل:', stderr);
                return res.status(500).json({ error: 'فشل في تحميل الفيديو' });
            }

            try {
                // البحث عن الملف المحمل
                const files = await fs.readdir(DOWNLOADS_DIR);
                const downloadedFile = files.find(file => 
                    file.includes(videoId) && file.includes(quality.replace('p', ''))
                );

                if (downloadedFile) {
                    const downloadUrl = `/downloads/${downloadedFile}`;
                    res.json({
                        success: true,
                        downloadUrl,
                        filename: downloadedFile,
                        message: 'تم تحميل الفيديو بنجاح'
                    });
                } else {
                    res.status(500).json({ error: 'لم يتم العثور على الملف المحمل' });
                }
            } catch (fsError) {
                console.error('خطأ في قراءة مجلد التحميلات:', fsError);
                res.status(500).json({ error: 'خطأ في الوصول للملفات' });
            }
        });

    } catch (error) {
        console.error('خطأ عام في التحميل:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// API للحصول على حالة الخادم
app.get('/api/status', async (req, res) => {
    const ytDlpExists = await checkYtDlp();
    res.json({
        status: 'running',
        ytDlp: ytDlpExists ? 'متاح' : 'غير متاح',
        message: ytDlpExists ? 'الخادم جاهز للاستخدام' : 'يرجى تثبيت yt-dlp'
    });
});

// API لحذف الملفات القديمة (تنظيف)
app.delete('/api/cleanup', async (req, res) => {
    try {
        const files = await fs.readdir(DOWNLOADS_DIR);
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 ساعة

        let deletedCount = 0;
        for (const file of files) {
            const filePath = path.join(DOWNLOADS_DIR, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
                deletedCount++;
            }
        }

        res.json({
            success: true,
            deletedFiles: deletedCount,
            message: `تم حذف ${deletedCount} ملف قديم`
        });
    } catch (error) {
        console.error('خطأ في التنظيف:', error);
        res.status(500).json({ error: 'خطأ في تنظيف الملفات' });
    }
});

// بدء الخادم
async function startServer() {
    try {
        await ensureDownloadsDir();
        
        app.listen(PORT, () => {
            console.log(`🚀 خادم اليوتيوب يعمل على المنفذ ${PORT}`);
            console.log(`📁 مجلد التحميلات: ${DOWNLOADS_DIR}`);
            
            checkYtDlp().then(exists => {
                if (exists) {
                    console.log('✅ yt-dlp متاح وجاهز للاستخدام');
                } else {
                    console.log('❌ yt-dlp غير متاح - يرجى التثبيت أولاً');
                    console.log('   قم بتشغيل: pip install yt-dlp');
                }
            });
        });
    } catch (error) {
        console.error('خطأ في بدء الخادم:', error);
        process.exit(1);
    }
}

// إيقاف الخادم بشكل آمن
process.on('SIGTERM', () => {
    console.log('🛑 إيقاف الخادم...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 إيقاف الخادم...');
    process.exit(0);
});

startServer();