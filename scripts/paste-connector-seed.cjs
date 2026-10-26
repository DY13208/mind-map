"use strict";
const assert = require("node:assert/strict");
assert.equal(process.env.MIND_MAP_SKIP_ROOT_ENV, "1");
assert.match(process.env.PGDATABASE || "", /^mcp_guards_test_[a-f0-9]{12}$/);
const storage = require("../simple-mind-map/bin/storage");
process.once("message", async ({ roomKey, userIds }) => {
  try {
    const nodes = {
      root: {
        isRoot: true,
        data: { uid: "root", text: "批量复制粘贴残线隔离测试", expand: true },
        children: []
      }
    };
    for (let i = 0; i < 16; i++) {
      const uid = "b" + i;
      nodes.root.children.push(uid);
      nodes[uid] = {
        data: { uid, text: "分支 " + i, expand: true },
        children: []
      };
      for (let j = 0; j < 4; j++) {
        const child = uid + "l" + j;
        nodes[uid].children.push(child);
        nodes[child] = {
          data: { uid: child, text: "节点 " + i + "/" + j, expand: true },
          children: []
        };
        for (let k = 0; k < 3; k++) {
          const leaf = child + "s" + k;
          nodes[child].children.push(leaf);
          nodes[leaf] = {
            data: { uid: leaf, text: "末级 " + k },
            children: []
          };
        }
      }
    }
    await storage.upsertRoom(roomKey, "批量复制粘贴残线隔离测试", {
      nodes,
      allowFullTree: true
    });
    const pool = storage.getPool();
    for (const userId of userIds)
      await pool.query(
        "insert into room_members(room_key,user_id,role,direct_role,source) values($1,$2,'owner','owner','direct_share')",
        [roomKey, userId]
      );
    process.send({ ok: true });
    await pool.end();
  } catch (error) {
    process.send({ error: error.message });
  } finally {
    process.disconnect();
  }
});
