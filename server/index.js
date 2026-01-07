import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { parse } from "csv-parse";
import { db, initDb } from "./db.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const PORT = process.env.PORT || 3001;

initDb();

// helpers
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.sendStatus(401);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.sendStatus(403);
  next();
}
function normalizeId(v) {
  const c = String(v || "").trim().toUpperCase();
  return /^[A-Z0-9-]{3,40}$/.test(c) ? c : null;
}

// register (first user = admin)
app.post("/api/auth/register", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  db.run(
    "INSERT INTO users(email,password_hash,role) VALUES(?,?,?)",
    [req.body.email, hash, "admin"],
    () => res.json({ ok: true })
  );
});

// login
app.post("/api/auth/login", (req, res) => {
  db.get("SELECT * FROM users WHERE email=?", [req.body.email], async (_, u) => {
    if (!u || !(await bcrypt.compare(req.body.password, u.password_hash)))
      return res.sendStatus(401);
    res.json({
      token: jwt.sign({ id: u.id, role: u.role }, JWT_SECRET)
    });
  });
});

// QR lookup
app.get("/api/qrcodes/:code", auth, (req, res) => {
  const code = normalizeId(req.params.code);
  if (!code) return res.status(400).json({ error: "Invalid QR ID" });

  db.get("SELECT id FROM qrcodes WHERE code=?", [code], (_, qr) => {
    if (!qr) return res.json({ code, items: [] });

    db.all(
      `SELECT i.name, i.sku, qi.qty
       FROM qrcode_items qi
       JOIN items i ON i.id = qi.item_id
       WHERE qi.qrcode_id = ?`,
      [qr.id],
      (_, rows) => res.json({ code, items: rows })
    );
  });
});

// CSV import (admin)
app.post("/api/admin/import", auth, adminOnly, upload.single("file"), (req, res) => {
  parse(req.file.buffer, { columns: true }, (_, rows) => {
    rows.forEach(r => {
      const code = normalizeId(r.code);
      if (!code) return;

      db.run("INSERT OR IGNORE INTO qrcodes(code) VALUES(?)", [code]);
      db.get("SELECT id FROM qrcodes WHERE code=?", [code], (_, qr) => {
        db.run("INSERT INTO items(name,sku) VALUES(?,?)", [r.name, r.sku]);
        db.get("SELECT last_insert_rowid() id", (_, it) => {
          db.run(
            "INSERT INTO qrcode_items VALUES(?,?,?)",
            [qr.id, it.id, r.qty || 1]
          );
        });
      });
    });
    res.json({ ok: true });
  });
});

app.get("/", (req, res) => res.send("QR Scan API is running ✅"));
app.listen(PORT, () => console.log("API running on port", PORT));
