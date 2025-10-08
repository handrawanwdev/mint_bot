const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const dns = require("dns").promises;

const { fetch: undiciFetch } = require("undici");
const { CookieJar } = require("tough-cookie");
const fetchCookie = require("fetch-cookie").default;

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
const PAGES_DIR = path.join(__dirname, "pages");
const API_URL = (options.url || "https://antrisimatupang.com").trim();
const CSV_FILE = options.csv || "batch_data.csv";
const PARALLEL_LIMIT = 2;
const OFFSET_MS = 100; // jangan terlalu cepat

if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);
if (!fs.existsSync(ERROR_LOG)) fs.writeFileSync(ERROR_LOG, "timestamp,ktp,name,error_message\n");
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR);

let isRunning = false;
let processedData = [];
let successKTP = [];

// ==========================
// 🕒 HELPERS
// ==========================
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

async function waitUntilServerUp(retryDelay = 3000) {
  while (true) {
    const online = await isOnline();
    if (!online) {
      // console.log("⚠️ Tidak ada koneksi internet, tunggu koneksi...");
      await delay(retryDelay);
      continue;
    }
    const serverUp = await isServerUp();
    if (serverUp) {
      // console.log("🟢 Server up, lanjut eksekusi...");
      return;
    }
    // console.log(`🔴 Server masih down, ulangi cek dalam ${retryDelay / 1000} detik...`);
    await delay(retryDelay + Math.random() * 1000);
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
// 📤 POST DATA
// ==========================
async function postDataContinuous(item) {
  let attempt = 0;
  while (true) {
    attempt++;
    console.log(`🔄 [${item.ktp}|${item.name}] Coba ke-${attempt}...`);
    try {
      const localJar = new CookieJar(); // fresh session per KTP
      const localFetch = fetchCookie(undiciFetch, localJar);

      // Ambil halaman baru — fresh session
      const pageRes = await localFetch(API_URL, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const html = await pageRes.text();
      const resFile = path.join(PAGES_DIR, `page_${item.ktp}.html`);
      fs.writeFileSync(resFile, html);

      if(html.toUpperCase().includes("TUTUP") || html.toUpperCase().includes("MAAF")) {
        throw new Error("Pendaftaran ditutup");
      }

      // Ambil _token
      const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/i);
      if (!tokenMatch) throw new Error("_token tidak ditemukan");
      const token = tokenMatch[1];

      // Ambil captcha
      const captchaMatch = html.match(/<div[^>]+id=["']captcha-box["'][^>]*>([\s\S]*?)<\/div>/i);
      const captcha = captchaMatch ? captchaMatch[1].replace(/[\s\r\n\t]+/g, "").trim() : "";

      const payload = {
        name: (item.name || "").toString().trim(),
        ktp: (item.ktp || "").toString().replace(/\D/g, "").slice(0, 16),
        phone_number: (item.phone || "").toString().replace(/\D/g, "").slice(0, 12),
        captcha_input: captcha,
        check: "on",
        check_2: "on",
        _token: token,
      };

      console.log(`📤 Kirim: ${item.ktp}|${item.name} (Attempt ${attempt})`);

      const postRes = await localFetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(payload).toString(),
      });
      const postHtml = await postRes.text();

      if (postHtml.includes("Pendaftaran Berhasil")) {
        const noMatch = postHtml.match(/Nomor\s+Antrian:\s*([A-Z0-9]+\s*[A-Z]-\d+)/i);
        const nomor = noMatch ? noMatch[1] : "Nomor tidak terbaca";
        console.log(`   ✅ ${item.ktp}|${item.name} → ${nomor}`);
        return { ...payload, status: "OK", info: `Pendaftaran berhasil, Nomor Antrian: ${nomor}`, error_message: "" };
      }

      // Jika gagal validasi
      const errMatch = postHtml.match(/<div class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/i);
      const errMsg = errMatch ? errMatch[1].replace(/<[^>]+>/g, "").trim() || "Validasi gagal" : "Error tidak dikenal";
      console.log(`   ❌ ${item.ktp}|${item.name}: ${errMsg}`);
      fs.appendFileSync(ERROR_LOG, `[${timestamp()}] | ${item.ktp},${item.name},"${errMsg}"\n`);

      // Delay random kecil sebelum retry
      await delay(500 + Math.random() * 1000);

    } catch (err) {
      console.log(`   🚨 ${item.ktp}|${item.name}: ${err.message}`);
      await delay(1000 + Math.random() * 2000);
    }
  }
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
  const now = new Date();
  const isPeakTime = now.getHours() === 15 && now.getMinutes() < 2;
  const limit = isPeakTime ? 2 : 1;
  console.log(`Memproses ${data.length} entri dari ${CSV_FILE}`);
  for (let i = 0; i < data.length; i += PARALLEL_LIMIT) {
    console.log(`Memproses entri ke ${i + 1} s.d ${Math.min(i + PARALLEL_LIMIT, data.length)}...`);
    const timeStart = Date.now();
    const chunk = data.slice(i, i + PARALLEL_LIMIT);
    const results = await Promise.all(chunk.map(postDataContinuous));
    processedData.push(...results);
    // Delay hanya jika belum selesai
    if (i + limit < data.length) {
      await delay(Math.floor(Math.random() * 600) + 200); // 300–900ms
    }
    const timeTaken = (Date.now() - timeStart) / 1000;
    console.log(`   ⏱️ Waktu chunk: ${timeTaken.toFixed(2)}s`);
    console.log(`   ⏳ Tersisa: ${data.length - (i + limit) < 0 ? 0 : data.length - (i + limit)} entri`);
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
const MODE_APP = options.mode;

function getDelayToTime(hour, minute = 0, second = 0) {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    second,
    OFFSET_MS
  );
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

async function scheduleBatch() {
  let delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);
  console.log(
    `🕒 [${API_URL}] Batch dijadwalkan pukul ${String(SCHEDULE_HOUR).padStart(2, '0')}:${String(SCHEDULE_MINUTE).padStart(2, '0')}:${String(SCHEDULE_SECOND).padStart(2, '0')} (delay ${Math.round(
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
        `\r🕒 Menunggu batch berikutnya → ${String(hours).padStart(2, '0')} jam ${String(minutes).padStart(2, '0')} menit ${String(seconds).padStart(2, '0')} detik`
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
if(MODE_APP && MODE_APP == "0"){
  runBatch().catch((err) => console.error("🚨 Error batch:", err));
}else{
  scheduleBatch();
}
