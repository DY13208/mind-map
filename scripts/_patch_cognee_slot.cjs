const fs = require("fs");
const p = "scripts/openclaw-docker.js";
let s = fs.readFileSync(p, "utf8");
const marker = "LIANGCE_COGNEE_SLOT_GUARD";
if (s.includes(marker)) {
  console.log("already patched");
  process.exit(0);
}
const needle = "const pluginInstalled = cogneeEnabled() && probe.ok";
const idx = s.indexOf(needle);
if (idx < 0) {
  console.error("needle not found");
  process.exit(1);
}
const replacement =
  "/* " + marker + " */\n" +
  "    // Keep Cognee memory slot whenever plugin files exist on the volume.\n" +
  "    // COGNEE_ENABLED=false alone must NOT clear plugins.slots.memory.\n" +
  "    const pluginFilesPresent = probe.ok\n" +
  "    const cogneeWanted = cogneeEnabled()\n" +
  "    const pluginInstalled = pluginFilesPresent && cogneeWanted";
s = s.slice(0, idx) + replacement + s.slice(idx + needle.length);

// Find disable branch after this section
const disableNeedle = "} else if (!probe.indeterminate) {\n      disableCogneePlugin(cfg)\n    }";
const dIdx = s.indexOf(disableNeedle);
if (dIdx < 0) {
  // try CRLF
  const disableNeedle2 = "} else if (!probe.indeterminate) {\r\n      disableCogneePlugin(cfg)\r\n    }";
  const dIdx2 = s.indexOf(disableNeedle2);
  if (dIdx2 < 0) {
    console.error("disable branch not found");
    process.exit(1);
  }
  const rep2 =
    "} else if (!probe.ok && !probe.indeterminate) {\r\n" +
    "      disableCogneePlugin(cfg)\r\n" +
    "    } else if (pluginFilesPresent) {\r\n" +
    "      cfg.plugins = cfg.plugins || {}\r\n" +
    "      cfg.plugins.entries = cfg.plugins.entries || {}\r\n" +
    "      cfg.plugins.entries[COGNEE_PLUGIN_ID] = {\r\n" +
    "        ...(cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}),\r\n" +
    "        enabled: true\r\n" +
    "      }\r\n" +
    "      cfg.plugins.slots = cfg.plugins.slots || {}\r\n" +
    "      cfg.plugins.slots.memory = COGNEE_PLUGIN_ID\r\n" +
    "      cogneeActive = true\r\n" +
    "    }";
  s = s.slice(0, dIdx2) + rep2 + s.slice(dIdx2 + disableNeedle2.length);
} else {
  const rep =
    "} else if (!probe.ok && !probe.indeterminate) {\n" +
    "      disableCogneePlugin(cfg)\n" +
    "    } else if (pluginFilesPresent) {\n" +
    "      cfg.plugins = cfg.plugins || {}\n" +
    "      cfg.plugins.entries = cfg.plugins.entries || {}\n" +
    "      cfg.plugins.entries[COGNEE_PLUGIN_ID] = {\n" +
    "        ...(cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}),\n" +
    "        enabled: true\n" +
    "      }\n" +
    "      cfg.plugins.slots = cfg.plugins.slots || {}\n" +
    "      cfg.plugins.slots.memory = COGNEE_PLUGIN_ID\n" +
    "      cogneeActive = true\n" +
    "    }";
  s = s.slice(0, dIdx) + rep + s.slice(dIdx + disableNeedle.length);
}

fs.writeFileSync(p, s);
console.log("patched ok");
