const { signToken } = require('../integrations/knowledge-mcp/src/auth/jwt');
const secret = process.env.KNOWLEDGE_MCP_JWT_SECRET;
const userId = process.argv[2];
const { token } = signToken({ userId, secret, ttlSec: 180, iss: process.env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce', aud: process.env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp' });
process.stdout.write(token);
