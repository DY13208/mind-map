const fs = require("fs");
const { execSync } = require("child_process");
function sh(c){ console.log(">>", c.slice(0,140)); return execSync(c, {encoding:"utf8", windowsHide:true}); }
sh("docker run --rm -v mind-map_mind-map-openclaw:/data -v D:/mind-map/.tmp:/out alpine sh -c \"cp /data/openclaw.json /out/oc-acc2.json\"");
const cfg = JSON.parse(fs.readFileSync("D:/mind-map/.tmp/oc-acc2.json","utf8"));
delete cfg.plugins.allow;
cfg.plugins.slots = cfg.plugins.slots || {};
cfg.plugins.slots.memory = "cognee-openclaw";
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries["liangce-ingress"] = { ...(cfg.plugins.entries["liangce-ingress"]||{}), enabled: true };
cfg.plugins.load = cfg.plugins.load || {};
cfg.plugins.load.paths = Array.from(new Set([...(cfg.plugins.load.paths||[]), "/home/node/.openclaw/extensions/liangce-ingress"]));
cfg.mcp = cfg.mcp || {};
cfg.mcp.servers = cfg.mcp.servers || {};
cfg.mcp.servers["identity-mcp"] = { url: "http://host.docker.internal:18791/mcp" };
fs.writeFileSync("D:/mind-map/.tmp/oc-acc2.json", JSON.stringify(cfg,null,2));
sh("docker run --rm -v mind-map_mind-map-openclaw:/data -v D:/mind-map/.tmp:/out alpine sh -c \"cp /out/oc-acc2.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json\"");
sh("docker run --rm -v mind-map_mind-map-openclaw:/data -v D:/mind-map/integrations/openclaw/liangce-ingress:/src alpine sh -c \"cp /src/index.js /src/package.json /src/openclaw.plugin.json /data/extensions/liangce-ingress/; chown -R 1000:1000 /data/extensions/liangce-ingress\"");
console.log("memory", cfg.plugins.slots.memory, "mcp", cfg.mcp.servers);