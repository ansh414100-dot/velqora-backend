import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));

const videoExtensions = [".mp4", ".mov", ".m4v", ".webm"];
const audioExtensions = [".mp3", ".m4a", ".aac", ".wav", ".ogg"];

const INSTAGRAM_COOLDOWN_MS = 5 * 60 * 1000;
let instagramCooldownUntil = 0;
let instagramRequestRunning = false;

function getPlatform(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (["instagram.com", "instagr.am"].includes(host)) {
    return "instagram";
  }

  if (
    ["facebook.com", "m.facebook.com", "web.facebook.com", "fb.watch"].includes(host)
  ) {
    return "facebook";
  }

  if (
    ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)
  ) {
    return "youtube";
  }

  return "direct";
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function hasVideo(format) {
  return (
    format &&
    format.url &&
    format.vcodec &&
    format.vcodec !== "none"
  );
}

function hasAudio(format) {
  return (
    format &&
    format.url &&
    format.acodec &&
    format.acodec !== "none"
  );
}

function getHeaders(format, info) {
  return format?.http_headers || info?.http_headers || {};
}

app.get("/", (req, res) => {
  res.json({
    app: "Velqora Downloader",
    status: "online"
  });
});

app.post("/validate", (req, res) => {
  const { url } = req.body ?? {};

  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({
      valid: false,
      supported: false,
      message: "Please provide a URL."
    });
  }

  let parsed;

  try {
    parsed = new URL(url.trim());

    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Invalid URL");
    }
  } catch {
    return res.status(400).json({
      valid: false,
      supported: false,
      message: "Please enter a valid HTTP or HTTPS URL."
    });
  }

  const platform = getPlatform(parsed);

  if (platform !== "direct") {
    return res.json({
      valid: true,
      supported: false,
      platform,
      message:
        `${platform} links are recognized, but extraction must be tested separately.`
    });
  }

  const path = parsed.pathname.toLowerCase();
  const video = videoExtensions.some(ext => path.endsWith(ext));
  const audio = audioExtensions.some(ext => path.endsWith(ext));

  if (!video && !audio) {
    return res.json({
      valid: true,
      supported: false,
      platform: "direct",
      message: "Use a direct video or audio file URL."
    });
  }

  return res.json({
    valid: true,
    supported: true,
    platform: "direct",
    mediaType: video ? "video" : "audio",
    message: "Direct media URL format recognized.",
    downloadOptions: video ? ["video", "audio"] : ["audio"]
  });
});

app.post("/instagram-info", (req, res) => {
  const { url } = req.body ?? {};

  if (typeof url !== "string" || !isValidHttpUrl(url.trim())) {
    return res.status(400).json({
      success: false,
      message: "Please provide a valid URL."
    });
  }

  const parsed = new URL(url.trim());

  if (getPlatform(parsed) !== "instagram") {
    return res.status(400).json({
      success: false,
      message: "Please provide an Instagram URL."
    });
  }

  if (!/^\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i.test(parsed.pathname)) {
    return res.status(400).json({
      success: false,
      message: "Please provide a supported Instagram Reel or post URL."
    });
  }

  const now = Date.now();

  if (now < instagramCooldownUntil) {
    const retryAfter = Math.ceil(
      (instagramCooldownUntil - now) / 1000
    );

    return res.status(429).json({
      success: false,
      message: `Instagram is temporarily limiting requests. Please try again in ${retryAfter} seconds.`,
      retry_after: retryAfter
    });
  }

  if (instagramRequestRunning) {
    return res.status(429).json({
      success: false,
      message: "An Instagram request is already processing. Please try again shortly."
    });
  }

  instagramRequestRunning = true;

  execFile(
    "python3",
    [
      "-m",
      "yt_dlp",
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--no-download",
      "--extractor-args",
      "instagram:api=graphql",
      "--format",
      "bestvideo+bestaudio/best",
      "--",
      parsed.href
    ],
    {
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024
    },
    (error, stdout, stderr) => {
      instagramRequestRunning = false;

      if (error) {
        const errorText = String(stderr || error.message);

        console.error("Instagram extraction failed:", errorText);

        if (/HTTP Error 429|Too Many Requests|\b429\b/i.test(errorText)) {
          instagramCooldownUntil = Date.now() + INSTAGRAM_COOLDOWN_MS;

          return res.status(429).json({
            success: false,
            message: "Instagram is temporarily limiting requests. Please try again after 5 minutes.",
            retry_after: 300
          });
        }

        return res.status(502).json({
          success: false,
          message:
            "Could not extract this Instagram media. It may be unavailable, private, or login-restricted."
        });
      }

      try {
        const info = JSON.parse(stdout);

        const requestedFormats = Array.isArray(info.requested_formats)
          ? info.requested_formats
          : [];

        let videoFormat = null;
        let audioFormat = null;

        if (requestedFormats.length >= 2) {
          videoFormat = requestedFormats.find(hasVideo) || null;
          audioFormat = requestedFormats.find(hasAudio) || null;
        }

        if (videoFormat && audioFormat) {
          return res.json({
            success: true,
            platform: "instagram",
            title: info.title || "Instagram video",
            thumbnail: info.thumbnail || null,
            mode: "separate",
            videoUrl: videoFormat.url,
            audioUrl: audioFormat.url,
            videoHeaders: getHeaders(videoFormat, info),
            audioHeaders: getHeaders(audioFormat, info),
            extension: "mp4",
            hasAudio: true,
            hasVideo: true,
            message: "Separate audio and video streams extracted."
          });
        }

        const formats = Array.isArray(info.formats)
          ? info.formats
          : [];

        const combinedFormats = formats
          .filter(f => hasVideo(f) && hasAudio(f))
          .sort((a, b) => {
            return (
              (b.height || 0) - (a.height || 0) ||
              (b.tbr || 0) - (a.tbr || 0)
            );
          });

        const combined =
          hasVideo(info) && hasAudio(info)
            ? info
            : combinedFormats[0];

        if (combined?.url) {
          return res.json({
            success: true,
            platform: "instagram",
            title: info.title || "Instagram video",
            thumbnail: info.thumbnail || null,
            mode: "combined",
            downloadUrl: combined.url,
            downloadHeaders: getHeaders(combined, info),
            extension: combined.ext || "mp4",
            hasAudio: true,
            hasVideo: true,
            message: "Combined audio and video stream extracted."
          });
        }

        return res.status(502).json({
          success: false,
          message:
            "No usable audio and video streams were found for this post."
        });

      } catch (parseError) {
        console.error("Instagram JSON parsing failed:", parseError);

        return res.status(502).json({
          success: false,
          message:
            "The extraction service returned an unreadable response."
        });
      }
    }
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Velqora backend running on port ${PORT}`);
});
