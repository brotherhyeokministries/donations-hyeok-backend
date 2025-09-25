// api/public-recent-donations.js
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join("/tmp", "recent-donations.json");

// helper to safely load existing data
function loadDonations() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load donations:", e);
  }
  return [];
}

// helper to save data back
function saveDonations(donations) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(donations), "utf8");
  } catch (e) {
    console.error("Failed to save donations:", e);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let donations = loadDonations();

  // sort newest first
  donations.sort((a, b) => b.ts - a.ts);

  // === optional: exclude test/dev emails ===
  const EXCLUDED_EMAILS = [
    //"jedidiah.interaction@gmail.com",
    "hello@jedicreate.com"
  ];

  donations = donations.filter(
    d => !EXCLUDED_EMAILS.includes((d.email || "").toLowerCase())
  );

  // apply ?limit=10
  const limit = parseInt(req.query.limit, 10) || 10;
  const items = donations.slice(0, limit).map(d => ({
    name: d.name || "Someone",
    text: d.text || "",
    ts: d.ts || Math.floor(Date.now() / 1000)
  }));

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ items });
}