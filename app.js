const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const dns = require("dns").promises;

const { fetch: undiciFetch } = require("undici");
const { CookieJar } = require("tough-cookie");
const fetchCookie = require("fetch-cookie").default;

const jar = new CookieJar();
const fetchWithCookies = fetchCookie(undiciFetch, jar);

// ==========================
// ⚙️ CONFIG & CLI
// ==========================
const args = process.argv.slice(2);
const options = {};
args.forEach((arg) => {
  const [k, v] = arg.split("=");
  if (k && v) options[k.replace(/^--/, "")] = v;
});

const ERROR_DIR = path.join(__dirname, "errors");
const ERROR_LOG = path.join(__dirname, "errors.log");
const API_URL = (options.url || "https://antrisimatupang.com").trim();
const CSV_FILE = options.csv || "batch_data.csv";
const PARALLEL_LIMIT = 2;
const MAX_RETRY = 5;
const RETRY_DELAY = 3000;
const MAX_BACKOFF = 10000;

if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);
if (!fs.existsSync(ERROR_LOG))
  fs.writeFileSync(ERROR_LOG, "timestamp,ktp,name,error_message\n");

let isRunning = false;
let processedData = [];

// ==========================
// 🕒 HELPERS
// ==========================
const randomDelay = () => Math.floor(Math.random() * 800) + 400; // 400–1200ms
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const pad = (n) => n.toString().padStart(2, "0");
const timestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// Cek koneksi internet
async function isOnline() {
  try {
    await dns.resolve("google.com");
    return true;
  } catch {
    return false;
  }
}

// Cek status server
async function isServerUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(API_URL, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    console.warn("⚠️ Gagal cek server:", err.name, err.message);
    return false;
  }
}

async function waitUntilServerUp(retryDelay = 5000) {
  while (true) {
    const online = await isOnline();
    if (!online) {
      console.log("⚠️ Tidak ada koneksi internet, tunggu koneksi...");
      await delay(retryDelay);
      continue;
    }

    const serverUp = await isServerUp();
    if (serverUp) {
      // console.log("🟢 Server up, lanjut eksekusi...");
      return;
    }

    console.log(`🔴 Server masih down, ulangi cek dalam ${retryDelay / 1000} detik...`);
    await delay(retryDelay + Math.random() * 2000);
  }
}

// ==========================
// 🔁 FETCH DENGAN RETRY
// ==========================
// async function safeFetch(url, opts) {
//   try {
//     return await fetchWithRetry(url, opts);
//   } catch (err) {
//     retryFailCount++;
//     if (retryFailCount >= MAX_TOTAL_FAIL) {
//       console.error("🛑 Terlalu banyak kegagalan fetch, hentikan batch sementara");
//       process.exit(1);
//     }
//     throw err;
//   }
// }

async function fetchWithRetry(url, opts = {}, retryCount = MAX_RETRY) {
  let delayMs = RETRY_DELAY;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    if (!(await isOnline())) {
      console.warn(`⚠️ [${attempt}/${retryCount}] Offline, tunggu 5 detik...`);
      await delay(5000);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetchWithCookies(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      console.warn(`❌ [${attempt}/${retryCount}] ${err.message}`);
      if (attempt < retryCount) {
        console.log(`⏳ Retry dalam ${delayMs / 1000}s...`);
        await delay(delayMs);
        delayMs = Math.min(delayMs * 1.5, MAX_BACKOFF);
      } else {
        throw new Error(
          `Gagal fetch setelah ${retryCount} percobaan: ${err.message}`
        );
      }
    }
  }
}

// ==========================
// 📂 CSV READER
// ==========================
function readCSV(file) {
  if (!fs.existsSync(file)) throw new Error(`CSV tidak ditemukan: ${file}`);
  const raw = fs.readFileSync(file, "utf-8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const required = ["name", "ktp", "phone"];
  const missing = required.filter((c) => !(c in records[0]));
  if (missing.length) throw new Error(`Kolom hilang: ${missing.join(", ")}`);
  return records;
}

function checkCSVFile(file) {
  console.log(`🔍 Cek file CSV: ${file}`);
  console.log(`📄 Membaca file ${file}...`);
  try {
    const data = readCSV(file);
    console.log(`📋 Ditemukan ${data.length} baris data.`);
    if (!data.length) {
      console.log(`📄 File ${file} kosong. Silakan isi data.`);
      process.exit(0);
    }
    console.log(`✅ File ${file} valid dengan ${data.length} baris data.`);
  } catch (err) {
    console.error(`🚨 Error baca CSV: ${err.message}`);
    process.exit(1);
  }
}

checkCSVFile(CSV_FILE);

// ==========================
// 🔐 TOKEN & CAPTCHA
// ==========================
async function getTokenAndCaptcha() {
  const res = await fetchWithRetry(API_URL, { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36" } });
  const html = await res.text();

  // Ambil _token
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error("_token tidak ditemukan");
  const token = tokenMatch[1];

  // Ambil captcha dari <div id="captcha-box">...</div>
  const captchaMatch = html.match(
    /<div[^>]+id=["']captcha-box["'][^>]*>([\s\S]*?)<\/div>/i
  );
  const captcha = captchaMatch
    ? captchaMatch[1].replace(/[\s\r\n]+/g, "").trim()
    : null;

  if (!captcha) console.warn("⚠️ Captcha tidak ditemukan di halaman utama.");

  return { token, captcha };
}

// async function getCaptcha() {
//   try {
//     const res = await safeFetch(`${API_URL}/reload-captcha`);
//     const j = await res.json();
//     return j.captcha || "";
//   } catch (err) {
//     console.log("⚠️ Gagal ambil captcha:", err.message);
//     return "";
//   }
// }

// ==========================
// 📤 POST DATA
// ==========================
async function postData(item) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 1. Ambil halaman baru — fresh session
      const pageRes = await fetchWithRetry(API_URL, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "DNT": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      const html = await pageRes.text();

      if(html.toUpperCase().includes("TUTUP") || html.toUpperCase().includes("MAAF")) {
        throw new Error("Pendaftaran ditutup");
      }

      // Ekstrak _token
      const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/i);
      if (!tokenMatch) throw new Error("_token tidak ditemukan");
      const token = tokenMatch[1];

      // Ekstrak captcha (teks biasa)
      const captchaMatch = html.match(/<div[^>]+id=["']captcha-box["'][^>]*>([\s\S]*?)<\/div>/i);
      const captcha = captchaMatch
        ? captchaMatch[1].replace(/[\s\r\n\t]+/g, "").trim()
        : "";

      // Siapkan payload
      const payload = {
        name: (item.name || "").toString().trim(),
        ktp: (item.ktp || "").toString().replace(/\D/g, "").slice(0, 16),
        phone_number: (item.phone || "").toString().replace(/\D/g, "").slice(0, 12),
        captcha_input: captcha,
        check: "on",
        check_2: "on",
        _token: token,
      };

      // 2. Kirim langsung — tanpa delay!
      const postRes = await fetchWithRetry(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": API_URL,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "DNT": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
        body: new URLSearchParams(payload).toString(),
      });

      const postHtml = await postRes.text();

      // Cek keberhasilan
      if (postHtml.includes("Pendaftaran Berhasil")) {
        const noMatch = postHtml.match(/Nomor\s+Antrian:\s*([A-Z0-9]+\s*[A-Z]-\d+)/i);
        const nomor = noMatch ? noMatch[1] : "Nomor tidak terbaca";
        console.log(`   ✅ ${item.ktp}|${item.name} → ${nomor}`);
        return { ...payload, status: "OK", info: `Pendaftaran berhasil, Nomor Antrian: ${nomor}`, error_message: "" };
      }

      // Cek 419 / Page Expired
      if (postHtml.includes("419") || postHtml.includes("Page Expired") || postHtml.includes("TokenMismatch")) {
        if (attempt === 0) {
          await delay(600 + Math.random() * 400); // retry cepat
          continue;
        } else {
          throw new Error("Token expired berulang");
        }
      }

      // Error validasi
      const errMatch = postHtml.match(/<div class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/i);
      const errMsg = errMatch
        ? errMatch[1].replace(/<[^>]+>/g, "").trim() || "Validasi gagal"
        : "Error tidak dikenal";

      const errFile = path.join(ERROR_DIR, `error_${payload.ktp}_${Date.now()}.html`);
      fs.writeFileSync(errFile, postHtml);
      console.log(`   ❌ ${item.ktp}|${item.name}: ${errMsg}`);
      fs.appendFileSync(ERROR_LOG, `${timestamp()},${item.ktp},${item.name},"${errMsg}"\n`);

      return {
        ...payload,
        status: "ERROR",
        error_message: errMsg,
        info: `HTML: ${path.basename(errFile)}`,
      };

    } catch (err) {
      const msg = err.message || "Unknown error";
      console.log(`   🚨 ${item.ktp}|${item.name}: ${msg}`);
      fs.appendFileSync(ERROR_LOG, `${timestamp()},${item.ktp},${item.name},"${msg}"\n`);
      return { ...item, status: "ERROR", error_message: msg, info: "" };
    }
  }

  return { ...item, status: "ERROR", error_message: "Gagal setelah 2 percobaan", info: "" };
}

// ==========================
// 💾 SAVE RESULT
// ==========================
function saveResults(data) {
  if (!data.length) return;
  fs.writeFileSync(`result_${CSV_FILE.toLowerCase().replace(".csv","")}.json`, JSON.stringify(data, null, 2));
  const headers = Object.keys(data[0]);
  const csv = data
    .map((d) =>
      headers
        .map((h) => `"${(d[h] ?? "").toString().replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
  const okCount = data.filter(d => d.status === "OK").length;
  const errCount = data.filter(d => d.status === "ERROR").length;
  console.log(`✅ Selesai: ${okCount} sukses, ${errCount} gagal`);

  fs.writeFileSync(`result_${CSV_FILE.toLowerCase().replace(".csv","")}.csv`, headers.join(",") + "\n" + csv);
  console.log(`✅ Hasil disimpan ke result_${CSV_FILE.toLowerCase().replace(".csv","")}.csv dan result_${CSV_FILE.toLowerCase().replace(".csv","")}.json`);
}

// ==========================
// 🧩 MAIN EXECUTION
// ==========================
async function runBatch() {
  console.log(`⚠️  Warning: jangan hentikan proses (CTRL+C) yang sedang berjalan!`);
  console.log(`🚀 Mulai batch untuk ${API_URL}`);
  console.log(`🕒 ${timestamp()}`);
  isRunning = true;
  const start = Date.now();
  const data = readCSV(CSV_FILE);
  console.log(`Memproses ${data.length} entri dari ${CSV_FILE}`);
  for (let i = 0; i < data.length; i += PARALLEL_LIMIT) {
    console.log(`Memproses entri ke ${i + 1} s.d ${Math.min(i + PARALLEL_LIMIT, data.length)}...`);
    const timeStart = Date.now();
    const chunk = data.slice(i, i + PARALLEL_LIMIT);
    const results = await Promise.all(chunk.map(postData));
    processedData.push(...results);
    // Delay acak antar entri
    if (i < data.length - 1) {
      const wait = Math.floor(Math.random() * 800) + 400; // 400–1200ms
      await delay(wait);
    }
    const timeTaken = (Date.now() - timeStart) / 1000;
    console.log(`   ⏱️ Waktu chunk: ${timeTaken.toFixed(2)}s`);
    console.log(`   ⏳ Tersisa: ${data.length - (i + PARALLEL_LIMIT) < 0 ? 0 : data.length - (i + PARALLEL_LIMIT)} entri`);
  }
  saveResults(processedData);
  console.log(`⏱️ Selesai dalam (${((Date.now() - start) / 1000).toFixed(2)} detik)`);
  console.log(`Waktu selesai: ${timestamp()}`);
  processedData = [];
  retryFailCount = 0;
  isRunning = false;
}

// ==========================
// ⏰ SCHEDULER
// ==========================
const SCHEDULE_HOUR = parseInt(options.hour) || 15;
const SCHEDULE_MINUTE = parseInt(options.minute) || 0;
const SCHEDULE_SECOND = parseInt(options.second) || 0;

function getDelayToTime(hour, minute = 0, second = 0) {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    second
  );
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

async function scheduleBatch() {
  let delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);
  console.log(
    `🕒 [${API_URL}] Batch dijadwalkan pukul ${SCHEDULE_HOUR}:${SCHEDULE_MINUTE}:${SCHEDULE_SECOND} (delay ${Math.round(
      delayMs / 1000
    )} detik)`
  );

  setInterval(async () => {
    delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);
    const hours = Math.floor(delayMs / 3600000);
    const minutes = Math.floor((delayMs % 3600000) / 60000);
    const seconds = Math.floor((delayMs % 60000) / 1000);

    if (!isRunning) {
      process.stdout.write(
        `\r🕒 Menunggu batch berikutnya → ${hours} jam ${minutes} menit ${seconds} detik`
      );
    }

    if (hours === 0 && minutes === 0 && seconds === 0 && !isRunning) {
      console.log("\n⏰ Waktu batch tiba! Mulai runBatch()");
      await runBatch().catch((err) => console.error("🚨 Error batch:", err));
    }
  }, 1000);
}

// ==========================
// ▶️ JALANKAN
// ==========================
// scheduleBatch();
runBatch().catch((err) => console.error("🚨 Error batch:", err));
