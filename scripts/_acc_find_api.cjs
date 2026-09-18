const { execSync } = require("child_process");
function sh(c) {
  try {
    return execSync(c, { encoding: "utf8", maxBuffer: 30e6, windowsHide: true });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || e.message);
  }
}
console.log("=== files with registerMcpServerConnectionResolver ===");
console.log(sh('docker exec mind-map-openclaw-gateway-1 sh -c "grep -rl registerMcpServerConnectionResolver /app/dist 2>/dev/null | head -30"'));
console.log("=== files with connectionResolver ===");
console.log(sh('docker exec mind-map-openclaw-gateway-1 sh -c "grep -rl connectionResolver /app/dist 2>/dev/null | head -30"'));
console.log("=== plugin api keys sample via openclaw ===");
console.log(sh('docker exec mind-map-openclaw-gateway-1 sh -c "grep -rl registerMcpServerConnectionResolver /app 2>/dev/null | head -20"'));
