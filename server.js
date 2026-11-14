import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

let instagramCooldownUntil = 0;
let instagramRequestRunning = false;

app.get("/", (req, res) => {
  res.json({
    app: "Velqora Downloader",
    status: "online"
  });
});

app.post("/validate", (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({
      success: false,
      message: "Please provide a URL."
    });
  }

  try {
    const parsed = new URL(url);

    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "youtu.be",
      "m.youtube.com",
      "instagram.com",
      "www.instagram.com",
      "instagr.am",
      "www.instagr.am"
    ];

    if (!allowedHosts.includes(parsed.hostname)) {
      return res.status(400).json({
        success: false,
        message: "This platform is not supported."
      });
    }

    return res.json({
      success: true,
      message: "URL is valid.",
      platform: parsed.hostname.includes("instagram")
        || parsed.hostname.includes("instagr.am")
        ? "instagram"
        : "youtube"
    });
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid URL."
    });
  }
});

app.post("/instagram-info", (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({
      success: false,
      message: "Instagram URL is required."
    });
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid Instagram URL."
    });
  }

  const allowedHosts = [
    "instagram.com",
    "www.instagram.com",
    "instagr.am",
    "www.instagr.am"
  ];

  if (!allowedHosts.includes(parsed.hostname)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid Instagram URL."
    });
  }

  if (!/^\/(reel|reels|p|tv)\//.test(parsed.pathname)) {
    return res.status(400).json({
      success: false,
      message: "Unsupported Instagram URL."
    });
  }

  if (Date.now() < instagramCooldownUntil) {
    const retryAfter = Math.ceil(
      (instagramCooldownUntil - Date.now()) / 1000
    );

    return res.status(429).json({
      success: false,
      message: `Instagram is temporarily limiting requests. Try again in ${retryAfter} seconds.`,
      retry_after: retryAfter
    });
  }

  if (instagramRequestRunning) {
    return res.status(429).json({
      success: false,
      message: "Another Instagram request is processing. Please try again shortly."
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
          instagramCooldownUntil = Date.now() + 5 * 60 * 1000;

          return res.status(429).json({
            success: false,
            message: "Instagram is temporarily limiting requests. Please try again after 5 minutes.",
            retry_after: 300
          });
        }

        return res.status(502).json({
          success: false,
          message: "Could not extract this Instagram media. It may be unavailable, private, or login-restricted."
        });
      }

      try {
        const info = JSON.parse(stdout);

        const videoUrl =
          info.url ||
          info.requested_downloads?.[0]?.url ||
          info.formats?.find((format) => format.url)?.url;

        if (!videoUrl) {
          return res.status(502).json({
            success: false,
            message: "No downloadable media was found."
          });
        }

        return res.json({
          success: true,
          title: info.title || "Instagram Video",
          video_url: videoUrl,
          audio_url: info.requested_downloads?.[1]?.url || null,
          thumbnail: info.thumbnail || null,
          headers: info.http_headers || {}
        });
      } catch (parseError) {
        console.error("Instagram JSON parsing failed:", parseError.message);

        return res.status(500).json({
          success: false,
          message: "Could not process Instagram media information."
        });
      }
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Velqora backend running on port ${PORT}`);
});
