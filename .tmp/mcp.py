import json,sys,urllib.request
URL="http://192.168.1.114:8989/mcp"
TOKEN="2972533e2c6ef5a4dec4fa08688bd2a8bd6e3ef671b3ef1e0e67c70ad91d51c1"
SID="97b33f98-8648-4405-84d9-e6af34215e4d"
def call(method,params,rid=3):
    body=json.dumps({"jsonrpc":"2.0","id":rid,"method":method,"params":params}).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":"Bearer "+TOKEN,"Mcp-Session-Id":SID})
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            raw=r.read().decode()
    except urllib.error.HTTPError as e:
        raw=e.read().decode()
    out=[]
    for line in raw.splitlines():
        if line.startswith("data: "):
            out.append(line[6:])
    if not out:
        out=[raw]
    txt="\n".join(out)
    try:
        return json.loads(txt)
    except Exception:
        return {"raw":txt}
if __name__=="__main__":
    name=sys.argv[1]; params=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
    res=call(name,params)
    print(json.dumps(res,ensure_ascii=False))
