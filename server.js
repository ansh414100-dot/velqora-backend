import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));

const videoExtensions = [".mp4", ".mov", ".m4v", ".webm"];
const audioExtensions = [".mp3", ".m4a", ".aac", ".wav", ".ogg"];

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

  execFile(
    "python3",
    [
      "-m",
      "yt_dlp",
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--no-download",
      "--",
      parsed.href
    ],
    {
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024
    },
    (error, stdout, stderr) => {
      if (error) {
        console.error("Instagram extraction failed:", stderr || error.message);

        return res.status(502).json({
          success: false,
          message:
            "Instagram could not provide this media. The post may be private, login-restricted, or temporarily unavailable."
        });
      }

      try {
        const info = JSON.parse(stdout);

        const formats = Array.isArray(info.formats) ? info.formats : [];
        const videoFormats = formats
          .filter(f => f.url && f.vcodec && f.vcodec !== "none")
          .sort((a, b) => (b.height || 0) - (a.height || 0));

        const chosen = videoFormats[0] || (
          info.url && info.vcodec !== "none" ? info : null
        );

        if (!chosen || !chosen.url) {
          return res.status(502).json({
            success: false,
            message: "No downloadable video format was returned."
          });
        }

        return res.json({
          success: true,
          platform: "instagram",
          title: info.title || "Instagram video",
          thumbnail: info.thumbnail || null,
          downloadUrl: chosen.url,
          extension: chosen.ext || "mp4",
          message: "Video information extracted successfully."
        });
      } catch {
        return res.status(502).json({
          success: false,
          message: "The extraction service returned an unreadable response."
        });
      }
    }
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Velqora backend running on port ${PORT}`);
});
