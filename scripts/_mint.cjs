const handoff = require("D:/mind-map/simple-mind-map/bin/openclawHandoff.js");
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = process.argv[2];
const issued = handoff.issueOpenclawHandoff({ id: process.argv[3] }, { conversationId: process.argv[4] });
process.stdout.write(issued.token);
