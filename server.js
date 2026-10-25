import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    app: "Velqora Downloader",
    status: "online"
  });
});

app.post("/validate", (req, res) => {
  const { url } = req.body;

  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({
      valid: false,
      message: "Please provide a URL."
    });
  }

  try {
    const parsedUrl = new URL(url);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid protocol");
    }

    return res.json({
      valid: true,
      message: "URL format is valid.",
      downloadOptions: ["video", "audio"]
    });
  } catch {
    return res.status(400).json({
      valid: false,
      message: "Please enter a valid HTTP or HTTPS URL."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Velqora backend running on port ${PORT}`);
});
