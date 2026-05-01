const fs = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
const { execWithPassword, isSudoAvailable } = require("../dns/dnsConfig.js");
const log = (msg) => console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] [MITM] ${msg}`);
const err = (msg) => console.error(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ❌ [MITM] ${msg}`);

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const LINUX_CERT_FILE = "9router-root-ca.crt";
const LINUX_CERT_STORES = [
  { dir: "/etc/ca-certificates/trust-source/anchors", update: "update-ca-trust", label: "Arch/CachyOS" },
  { dir: "/etc/pki/ca-trust/source/anchors", update: "update-ca-trust", label: "Fedora/RHEL" },
  { dir: "/usr/local/share/ca-certificates", update: "update-ca-certificates", label: "Debian/Ubuntu" },
];

// Get SHA1 fingerprint from cert file using Node.js crypto
function getCertFingerprint(certPath) {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g).join(":");
}

function commandExists(command) {
  try {
    require("child_process").execSync(`command -v ${command}`, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function resolveLinuxCertStore() {
  const existing = LINUX_CERT_STORES.find((store) => fs.existsSync(store.dir) && commandExists(store.update));
  if (existing) return existing;

  return LINUX_CERT_STORES.find((store) => commandExists(store.update)) || null;
}

/**
 * Check if certificate is already installed in system store
 */
async function checkCertInstalled(certPath) {
  if (IS_WIN) return checkCertInstalledWindows(certPath);
  if (IS_MAC) return checkCertInstalledMac(certPath);
  return checkCertInstalledLinux();
}

function checkCertInstalledMac(certPath) {
  return new Promise((resolve) => {
    try {
      const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
      // security verify-cert returns 0 only if cert is trusted by system policy
      exec(`security verify-cert -c "${certPath}" -p ssl -k /Library/Keychains/System.keychain 2>/dev/null`, { windowsHide: true }, (error) => {
        if (!error) return resolve(true);
        // Fallback: check if fingerprint appears in System keychain with trust
        exec(`security dump-trust-settings -d 2>/dev/null | grep -i "${fingerprint}"`, { windowsHide: true }, (err2, stdout2) => {
          resolve(!err2 && !!stdout2?.trim());
        });
      });
    } catch {
      resolve(false);
    }
  });
}

function checkCertInstalledWindows(certPath) {
  return new Promise((resolve) => {
    // Check Root store for our Root CA by common name
    exec("certutil -store Root \"9Router MITM Root CA\"", { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Install SSL certificate to system trust store
 */
async function installCert(sudoPassword, certPath) {
  if (!fs.existsSync(certPath)) {
    throw new Error(`Certificate file not found: ${certPath}`);
  }

  const isInstalled = await checkCertInstalled(certPath);
  if (isInstalled) {
    log("🔐 Cert: already trusted ✅");
    return;
  }

  if (IS_WIN) {
    await installCertWindows(certPath);
  } else if (IS_MAC) {
    await installCertMac(sudoPassword, certPath);
  } else {
    await installCertLinux(sudoPassword, certPath);
  }
}

async function installCertMac(sudoPassword, certPath) {
  // Remove all old certs with same name first to avoid duplicate/stale cert conflict
  const deleteOld = `security delete-certificate -c "9Router MITM Root CA" /Library/Keychains/System.keychain 2>/dev/null || true`;
  const install = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`;
  try {
    await execWithPassword(`${deleteOld} && ${install}`, sudoPassword);
    log("🔐 Cert: ✅ installed to system keychain");
  } catch (error) {
    const msg = error.message?.includes("canceled") ? "User canceled authorization" : "Certificate install failed";
    throw new Error(msg);
  }
}

async function installCertWindows(certPath) {
  // Process already has admin rights — run certutil directly, no UAC needed
  return new Promise((resolve, reject) => {
    exec(
      `certutil -addstore Root "${certPath}"`,
      { windowsHide: true },
      (error) => {
        if (error) reject(new Error(`Failed to install certificate: ${error.message}`));
        else { log("🔐 Cert: ✅ installed to Windows Root store"); resolve(); }
      }
    );
  });
}

/**
 * Uninstall SSL certificate from system store
 */
async function uninstallCert(sudoPassword, certPath) {
  const isInstalled = await checkCertInstalled(certPath);
  if (!isInstalled) {
    log("🔐 Cert: not found in system store");
    return;
  }

  if (IS_WIN) {
    await uninstallCertWindows();
  } else if (IS_MAC) {
    await uninstallCertMac(sudoPassword, certPath);
  } else {
    await uninstallCertLinux(sudoPassword);
  }
}

async function uninstallCertMac(sudoPassword, certPath) {
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
  const command = `security delete-certificate -Z "${fingerprint}" /Library/Keychains/System.keychain`;
  try {
    await execWithPassword(command, sudoPassword);
    log("🔐 Cert: ✅ uninstalled from system keychain");
  } catch (err) {
    throw new Error("Failed to uninstall certificate");
  }
}

async function uninstallCertWindows() {
  // Process already has admin rights — run certutil directly, no UAC needed
  return new Promise((resolve, reject) => {
    exec(
      `certutil -delstore Root "9Router MITM Root CA"`,
      { windowsHide: true },
      (error) => {
        if (error) reject(new Error(`Failed to uninstall certificate: ${error.message}`));
        else { log("🔐 Cert: ✅ uninstalled from Windows Root store"); resolve(); }
      }
    );
  });
}

function checkCertInstalledLinux() {
  return Promise.resolve(LINUX_CERT_STORES.some((store) => fs.existsSync(`${store.dir}/${LINUX_CERT_FILE}`)));
}

async function installCertLinux(sudoPassword, certPath) {
  if (!isSudoAvailable()) {
    log(`🔐 Cert: cannot install to system store without sudo — trust this file on clients: ${certPath}`);
    return;
  }

  const store = resolveLinuxCertStore();
  if (!store) {
    throw new Error("Certificate install failed: no supported Linux trust tool found");
  }

  const destFile = `${store.dir}/${LINUX_CERT_FILE}`;
  const cmd = `mkdir -p "${store.dir}" && cp "${certPath}" "${destFile}" && ${store.update}`;
  try {
    await execWithPassword(cmd, sudoPassword);
    log(`🔐 Cert: ✅ installed to Linux trust store (${store.label})`);
  } catch (error) {
    throw new Error(`Certificate install failed: ${error.message || "unknown error"}`);
  }
}

async function uninstallCertLinux(sudoPassword) {
  if (!isSudoAvailable()) {
    return;
  }

  const stores = LINUX_CERT_STORES.filter((store) => fs.existsSync(`${store.dir}/${LINUX_CERT_FILE}`) || commandExists(store.update));
  const commands = stores.map((store) => `rm -f "${store.dir}/${LINUX_CERT_FILE}"`).join(" && ");
  const updateCommands = [...new Set(stores.map((store) => store.update).filter(commandExists))].join(" && ");
  const cmd = [commands, updateCommands].filter(Boolean).join(" && ");

  if (!cmd) return;

  try {
    await execWithPassword(cmd, sudoPassword);
    log("🔐 Cert: ✅ uninstalled from Linux trust store");
  } catch (error) {
    throw new Error(`Failed to uninstall certificate: ${error.message || "unknown error"}`);
  }
}

module.exports = { installCert, uninstallCert, checkCertInstalled };
