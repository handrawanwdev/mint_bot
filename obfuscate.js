// obfuscate.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const obfuscator = require("javascript-obfuscator");

if (process.argv.length < 3) {
  console.log("Usage: node obfuscate.js <input.js> [--user=USERNAME] [--pass=PASSWORD]");
  process.exit(1);
}

const input = process.argv[2];
const args = process.argv.slice(3);

const opts = {};
args.forEach(a => {
  const [k, v] = a.split("=");
  if (k.startsWith("--")) opts[k.replace(/^--/, "")] = v;
});

// default credentials (ubah sesuai kebutuhan)
const USER = opts.user || "admin";
const PASS = opts.pass || "password123"; // hanya dipakai untuk membuat hash saat build

// compute sha256 of password (hex)
function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
const PASS_HASH = sha256(PASS);

// read app code
if (!fs.existsSync(input)) {
  console.error("Input file not found:", input);
  process.exit(1);
}
const appCode = fs.readFileSync(input, "utf8");

// loader that meminta username/password dan verifikasi hash
const loader = `
// --- LOGIN LOADER (auto-generated) ---
const crypto = require('crypto');
const readline = require('readline');

function sha256(s){ return crypto.createHash('sha256').update(s,'utf8').digest('hex'); }

// embedded credentials (hash)
const USER_EXPECT = ${JSON.stringify(USER)};
const PASS_HASH_EXPECT = ${JSON.stringify(PASS_HASH)};

function ask(question, mask=false){
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!mask) {
      rl.question(question, (ans) => { rl.close(); resolve(ans); });
    } else {
      // mask input (simple)
      const stdin = process.openStdin();
      process.stdin.on('data', char => {
        char = char + '';
        switch (char) {
          case '\\n': case '\\r': case '\\u0004':
            stdin.pause();
            break;
          default:
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            process.stdout.write(question + Array(rl.line.length + 1).join('*'));
            break;
        }
      });
      rl.question(question, (value) => {
        rl.history = rl.history.slice(1);
        rl.close();
        resolve(value);
      });
    }
  });
}

(async () => {
  try {
    const u = (await ask("Username: ")).trim();
    const p = (await ask("Password: ", true)).trim();
    const ph = sha256(p);
    if (u !== USER_EXPECT || ph !== PASS_HASH_EXPECT) {
      console.error("\\n✖ Login gagal. Keluar.");
      process.exit(1);
    }
    console.log("\\n✔ Login berhasil. Menjalankan aplikasi...\\n");
    // kalau berhasil, jalankan app asli
    (function(){
${appCode}
    })();
  } catch (e) {
    console.error("Error login:", e && e.message);
    process.exit(1);
  }
})();
`;

// obfuscate combined loader+app
const obf = obfuscator.obfuscate(loader, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.9,
  deadCodeInjection: true,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ['base64']
});

const out = path.basename(input, path.extname(input)) + ".obf.js";
fs.writeFileSync(out, obf.getObfuscatedCode(), "utf8");
console.log("✅ Obfuscated file created:", out);
console.log("   Username:", USER, "(embedded)");
console.log("   Password hash (sha256) embedded:", PASS_HASH);
