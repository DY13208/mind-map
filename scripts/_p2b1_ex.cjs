const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
const text=execSync(`docker exec ${c} cat /app/docs/plugins/sdk-channel-plugins.md`,{encoding:'utf8',maxBuffer:5e6});
const idx=text.indexOf('export default defineChannelPluginEntry');
console.log(text.slice(idx, idx+2500));
const idx2=text.indexOf('createChatChannelPlugin');
console.log('\n--- createChatChannelPlugin nearby ---\n');
console.log(text.slice(Math.max(0,idx2-200), idx2+2000));
