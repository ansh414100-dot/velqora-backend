import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const COOLDOWN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120000;

const platformCooldowns = new Map();
const activeRequests = new Set();

function detectPlatform(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    ) {
      return "youtube";
    }

    if (
      host === "facebook.com" ||
      host === "m.facebook.com" ||
      host === "fb.watch" ||
      host === "web.facebook.com"
    ) {
      return "facebook";
    }

    if (
      host === "instagram.com" ||
      host === "instagr.am"
    ) {
      return "instagram";
    }

    return "direct";
  } catch {
    return null;
  }
}

function isValidUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      ["-m", "yt_dlp", ...args],
      {
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: 15 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr || error.message || "Extraction failed";
          reject(new Error(message));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Unable to read video information."));
        }
      }
    );
  });
}

function getErrorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

function isRateLimited(message) {
  return (
    /429|too many requests|rate.?limit|rate.?limited/i.test(message)
  );
}

function getHeaders(info) {
  return info?.http_headers || {};
}

function getStream(format) {
  if (!format?.url) return null;

  return {
    url: format.url,
    headers: format.http_headers || {}
  };
}

function getMediaResult(info, platform) {
  const requestedFormats = info.requested_formats || [];

  let videoFormat = null;
  let audioFormat = null;
  let combinedFormat = null;

  if (requestedFormats.length >= 2) {
    videoFormat = requestedFormats.find(
      (format) => format.vcodec && format.vcodec !== "none"
    );

    audioFormat = requestedFormats.find(
      (format) => format.acodec && format.acodec !== "none"
    );
  }

  if (requestedFormats.length === 1) {
    combinedFormat = requestedFormats[0];
  }

  if (!combinedFormat && !videoFormat) {
    const formats = info.formats || [];

    combinedFormat =
      formats.find(
        (format) =>
          format.url &&
          format.vcodec !== "none" &&
          format.acodec !== "none"
      ) || null;
  }

  if (!combinedFormat && !videoFormat) {
    const directUrl = info.url;

    if (directUrl) {
      combinedFormat = {
        url: directUrl,
        http_headers: getHeaders(info),
        vcodec: info.vcodec,
        acodec: info.acodec
      };
    }
  }

  const videoStream = getStream(videoFormat);
  const audioStream = getStream(audioFormat);
  const combinedStream = getStream(combinedFormat);

  let mode = "combined";

  if (videoStream && audioStream) {
    mode = "separate";
  } else if (!combinedStream) {
    throw new Error("No downloadable video format was found.");
  }

  return {
    success: true,
    platform,
    title: info.title || "Video",
    thumbnail: info.thumbnail || "",
    duration: info.duration || 0,
    mode,

    downloadUrl: combinedStream?.url || null,
    downloadHeaders: combinedStream?.headers || {},

    videoUrl: videoStream?.url || null,
    videoHeaders: videoStream?.headers || {},

    audioUrl: audioStream?.url || null,
    audioHeaders: audioStream?.headers || {}
  };
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Velqora backend is running.",
    platforms: ["youtube", "facebook", "instagram", "direct"]
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online"
  });
});

// Validate a video URL
app.post("/validate", (req, res) => {
  const { url } = req.body || {};

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({
      valid: false,
      supported: false,
      message: "Please enter a valid video URL."
    });
  }

  const platform = detectPlatform(url);

  if (!platform) {
    return res.status(400).json({
      valid: false,
      supported: false,
      message: "Invalid URL."
    });
  }

  return res.json({
    valid: true,
    supported: true,
    platform,
    message: "URL accepted."
  });
});

// Main metadata and download information endpoint
app.post("/media-info", async (req, res) => {
  const { url } = req.body || {};

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid video URL."
    });
  }

  const platform = detectPlatform(url);

  if (!platform) {
    return res.status(400).json({
      success: false,
      message: "Unsupported URL."
    });
  }

  const now = Date.now();
  const cooldownUntil = platformCooldowns.get(platform) || 0;

  if (now < cooldownUntil) {
    const remainingSeconds = Math.ceil(
      (cooldownUntil - now) / 1000
    );

    return res.status(429).json({
      success: false,
      platform,
      message:
        `This platform is temporarily unavailable. ` +
        `Please try again in ${remainingSeconds} seconds.`
    });
  }

  if (activeRequests.has(platform)) {
    return res.status(429).json({
      success: false,
      platform,
      message: "Another request is being processed. Please try again shortly."
    });
  }

  activeRequests.add(platform);

  try {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--no-download",
      "--format",
      "bestvideo+bestaudio/best",
      "--extractor-retries",
      "1"
    ];

    if (platform === "instagram") {
      args.push(
        "--extractor-args",
        "instagram:api=graphql"
      );
    }

    args.push(url);

    const info = await runYtDlp(args);
    const result = getMediaResult(info, platform);

    return res.json(result);
  } catch (error) {
    const message = getErrorMessage(error);

    console.error(
      `${platform} extraction failed:`,
      message
    );

    if (isRateLimited(message)) {
      platformCooldowns.set(
        platform,
        Date.now() + COOLDOWN_MS
      );

      return res.status(429).json({
        success: false,
        platform,
        message:
          "The platform is temporarily limiting requests. Please try again later."
      });
    }

    return res.status(500).json({
      success: false,
      platform,
      message: "Unable to extract this video. It may be private, restricted, or temporarily unavailable."
    });
  } finally {
    activeRequests.delete(platform);
  }
});

// Compatibility endpoints
app.post("/youtube-info", (req, res) => {
  req.url = "/media-info";
  app.handle(req, res);
});

app.post("/facebook-info", (req, res) => {
  req.url = "/media-info";
  app.handle(req, res);
});

app.post("/instagram-info", (req, res) => {
  req.url = "/media-info";
  app.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`Velqora backend running on port ${PORT}`);
});
