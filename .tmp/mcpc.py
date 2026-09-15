import json,sys,urllib.request
URL="http://192.168.1.114:8989/mcp"
TOKEN="2972533e2c6ef5a4dec4fa08688bd2a8bd6e3ef671b3ef1e0e67c70ad91d51c1"
class MCP:
    def __init__(self):
        self.sid=None; self.rid=0
    def _post(self,obj):
        body=json.dumps(obj).encode()
        h={"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":"Bearer "+TOKEN}
        if self.sid: h["Mcp-Session-Id"]=self.sid
        req=urllib.request.Request(URL,data=body,headers=h)
        try:
            with urllib.request.urlopen(req,timeout=90) as r:
                if self.sid is None and r.headers.get("mcp-session-id"): self.sid=r.headers["mcp-session-id"]
                raw=r.read().decode()
        except urllib.error.HTTPError as e:
            raw=e.read().decode()
        out=[]
        for line in raw.splitlines():
            if line.startswith("data: "): out.append(line[6:])
        txt="\n".join(out) if out else raw
        try: return json.loads(txt)
        except Exception: return {"raw":txt}
    def call(self,method,params=None):
        self.rid+=1
        return self._post({"jsonrpc":"2.0","id":self.rid,"method":method,"params":params or {}})
m=MCP()
m.call("initialize",{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}})
m.call("notifications/initialized")
def tool(name,args):
    r=m.call("tools/call",{"name":name,"arguments":args})
    # extract content text
    try:
        cont=r["result"]["content"]
        txt="\n".join(c.get("text","") for c in cont if c.get("type")=="text")
        return txt
    except Exception:
        return json.dumps(r,ensure_ascii=False)
if __name__=="__main__":
    name=sys.argv[1]; args=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
    print(tool(name,args))
