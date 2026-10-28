import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));

const videoExtensions = [".mp4", ".mov", ".m4v", ".webm"];
const audioExtensions = [".mp3", ".m4a", ".aac", ".wav", ".ogg"];

function getPlatform(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "instagram.com" || host === "instagr.am") {
    return "instagram";
  }

  if (["facebook.com", "m.facebook.com", "web.facebook.com", "fb.watch"].includes(host)) {
    return "facebook";
  }

  if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    return "youtube";
  }

  return "direct";
}

app.get("/", (req, res) => {
  res.json({ app: "Velqora Downloader", status: "online" });
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

    if (!["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password) {
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
    const names = {
      instagram: "Instagram",
      facebook: "Facebook",
      youtube: "YouTube"
    };

    return res.json({
      valid: true,
      supported: false,
      platform,
      message: `${names[platform]} links are recognized, but direct extraction is not supported. Use an authorized media file or official permitted integration.`
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Velqora backend running on port ${PORT}`);
});
