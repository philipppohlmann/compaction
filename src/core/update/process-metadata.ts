import childProcess from "node:child_process";
import { closeSync, openSync, readSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

type Tool = "codex" | "claude" | "cursor-agent";
export interface ToolExecutable { path: string; tool: Tool }
export interface ToolProcessMetadata {
  pid: number; uid: number; birth: string; executable: string; cwd: string; tool: Tool; recorded: boolean;
  dispatch: "ordinary" | "chrome-native-host";
  environment: Partial<Record<"HOME" | "PATH" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR", string>>;
}

/** Self-contained: the exact same bounded decoder/parser runs in Node and the stock JXA helper.
 * Raw arguments and unselected environment values never cross the helper boundary. */
export function processMetadataParser() {
  const decode = (bytes: ArrayLike<number>, start: number, end: number): string => {
    let text = "";
    if (end - start > 16384) throw new Error("metadata bounds");
    for (let i = start; i < end;) {
      const a = bytes[i++]; let value = a, count = 0, minimum = 0;
      if (a >= 0xc2 && a <= 0xdf) { value = a & 31; count = 1; minimum = 0x80; }
      else if (a >= 0xe0 && a <= 0xef) { value = a & 15; count = 2; minimum = 0x800; }
      else if (a >= 0xf0 && a <= 0xf4) { value = a & 7; count = 3; minimum = 0x10000; }
      else if (a > 0x7f || a === 0) throw new Error("metadata encoding");
      if (i + count > end) throw new Error("metadata encoding");
      for (let n = 0; n < count; n++) { const b = bytes[i++]; if (b < 0x80 || b > 0xbf) throw new Error("metadata encoding"); value = value * 64 + (b & 63); }
      if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new Error("metadata encoding");
      if (value <= 0xffff) text += String.fromCharCode(value);
      else { value -= 0x10000; text += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 1023)); }
    }
    return text;
  };
  const parse = (bytes: ArrayLike<number>, length: number, darwin: boolean, candidate: boolean) => {
    if (!Number.isSafeInteger(length) || length < 1 || length >= 262144) throw new Error("metadata bounds");
    let offset = darwin ? 4 : 0; let invoked: string | undefined;
    const endOfString = (): number => { let end = offset; while (end < length && bytes[end] !== 0) end++; if (end === length) throw new Error("metadata truncation"); return end; };
    const args: Array<[number, number]> = [];
    if (darwin) {
      const argc = bytes[0] + bytes[1] * 256 + bytes[2] * 65536 + bytes[3] * 16777216;
      if (argc < 1 || argc > 4096) throw new Error("metadata argc");
      const invokedEnd = endOfString(); invoked = decode(bytes, offset, invokedEnd); offset = invokedEnd + 1;
      while (offset < length && bytes[offset] === 0) offset++;
      for (let i = 0; i < argc; i++) { const end = endOfString(); args.push([offset, end]); offset = end + 1; }
    } else {
      // Linux argv and environ are separate kernel files. Only argv uses candidate=false.
      if (!candidate) {
        let count = 0;
        while (offset < length) { const end = endOfString(); args.push([offset, end]); offset = end + 1; if (++count > 4096) throw new Error("metadata argc"); }
      }
    }
    const environment: ToolProcessMetadata["environment"] = {};
    if (candidate) {
      const keys: Record<string, true> = Object.create(null);
      let count = 0;
      while (offset < length && bytes[offset] !== 0) {
        const end = endOfString(); let equals = offset;
        while (equals < end && bytes[equals] !== 61) equals++;
        if (equals === offset || equals === end || equals - offset > 1024 || ++count > 8192) throw new Error("metadata environment");
        const key = decode(bytes, offset, equals);
        if (Object.prototype.hasOwnProperty.call(keys, key)) throw new Error("metadata duplicate");
        keys[key] = true;
        if (["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].indexOf(key) !== -1) environment[key as keyof typeof environment] = decode(bytes, equals + 1, end);
        offset = end + 1;
      }
      // KERN_PROCARGS2 copies the saved stack string area, not just environ (XNU
      // kern_sysctl.c: sysctl_procargsx). Its empty-string terminator ends the environment;
      // later stack/Apple data must neither be decoded nor confused with environment keys.
      if (darwin && offset >= length) throw new Error("metadata truncation");
      if (!darwin) for (; offset < length; offset++) if (bytes[offset] !== 0) throw new Error("metadata trailing data");
    }
    // Never decode argv[0]. Only the bounded interpreter option grammar selects a script;
    // prompt/code operands are never interpreted as paths or returned to the caller.
    const script = (interpreter = "node"): { value: string; index: number } | undefined => {
      for (let i = 1; i < args.length; i++) {
        const value = decode(bytes, args[i][0], args[i][1]);
        if (!value.startsWith("-")) return { value, index: i };
        if (["-e", "--eval", "-p", "--print", "-c", "-m"].indexOf(value) !== -1 || /^--(?:eval|print)=/.test(value)) return undefined;
        if (["bash", "sh", "zsh"].indexOf(interpreter) !== -1 && (/^-[ilrsxvufmnbBeEHT]+$/.test(value) || ["--login", "--noprofile", "--norc"].indexOf(value) !== -1)) continue;
        if (value === "--") return args[i + 1] ? { value: decode(bytes, args[i + 1][0], args[i + 1][1]), index: i + 1 } : undefined;
        if (["--enable-source-maps", "--no-warnings", "--trace-warnings", "--experimental-strip-types", "--experimental-import-meta-resolve", "--experimental-vm-modules", "--preserve-symlinks", "--preserve-symlinks-main", "-u", "-B"].indexOf(value) !== -1) continue;
        if (["--require", "-r", "--import", "--loader", "--experimental-loader", "--title", "--conditions", "-C"].indexOf(value) !== -1) { if (++i >= args.length) throw new Error("metadata options"); continue; }
        if (/^--[a-z][a-z0-9-]*=/.test(value) || /^--(?:inspect|inspect-brk|trace-deprecation|no-deprecation)$/.test(value)) continue;
        throw new Error("metadata options");
      }
      return undefined;
    };
    // Project only the one vendor dispatch that is provably non-interactive. Any additional
    // argument, unreadable token, or unknown shape remains ordinary or fails the whole projection.
    const dispatch = (start: number): "ordinary" | "chrome-native-host" => {
      if (!Number.isSafeInteger(start) || start < 1 || start > args.length) throw new Error("metadata dispatch");
      return args.length === start + 1 && decode(bytes, args[start][0], args[start][1]) === "--chrome-native-host"
        ? "chrome-native-host" : "ordinary";
    };
    return { script, dispatch, environment, invoked };
  };
  return { decode, parse };
}

// Darwin's public proc_info.h ABI (64-bit Intel and arm64). Every call checks its exact return
// size. Kernel buffers are bounded, held only inside this short-lived OS interpreter, zeroed,
// and freed on every exit. The program emits only the closed projection or {ok:false}.
const darwinProgram = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('calloc',['unsigned long',['unsigned long','unsigned long']]);
ObjC.bindFunction('memset',['unsigned char *',['unsigned long','int','unsigned long']]);
ObjC.bindFunction('free',['void',['unsigned long']]);
ObjC.bindFunction('getuid',['unsigned int',[]]);
ObjC.bindFunction('kill',['int',['int','int']]);
ObjC.bindFunction('__error',['int *',[]]);
ObjC.bindFunction('sysctl',['int',['unsigned long','unsigned int','unsigned long','unsigned long','unsigned long','unsigned long']]);
ObjC.bindFunction('proc_pidinfo',['int',['int','int','unsigned long long','unsigned long','int']]);
ObjC.bindFunction('proc_pidpath',['int',['int','unsigned long','unsigned int']]);
ObjC.bindFunction('realpath',['unsigned long',['char *','unsigned long']]);
function run(args) {
  var allocations=[], parser=PARSER(), results=[],stage='request';
  var ABI={bsd:136,pid:12,uid:20,ruid:28,seconds:120,micros:128,vnode:2352,cwd:152,path:1024,exe:4096,args:262144};
  function allocate(length) {
    var address=Number($.calloc(length,1));
    if(!Number.isSafeInteger(address)||address<=0)throw Error('allocation');
    allocations.push([address,length]);return {address:address,bytes:$.memset(address,0,length),length:length};
  }
  function u32(b,o){return b[o]+b[o+1]*256+b[o+2]*65536+b[o+3]*16777216;}
  function put32(b,o,n){for(var i=0;i<4;i++){b[o+i]=n%256;n=Math.floor(n/256);}}
  function u64(b,o){var n=u32(b,o)+u32(b,o+4)*4294967296;if(!Number.isSafeInteger(n))throw Error('integer');return n;}
  function text(buffer,start,limit){var end=start;while(end<limit&&buffer.bytes[end]!==0)end++;if(end===limit)throw Error('path bounds');return parser.decode(buffer.bytes,start,end);}
  function absolute(value){return typeof value==='string'&&value.charAt(0)==='/'&&value.indexOf('\n')===-1&&value.indexOf('\r')===-1;}
  function physical(value,cwd){if(!absolute(value))value=cwd+'/'+value;$.memset(canonical.address,0,ABI.exe);if(Number($.realpath(value,canonical.address))!==canonical.address)throw Error('script path');return text(canonical,0,ABI.exe);}
  function base(value){return value.slice(value.lastIndexOf('/')+1);}
  try {
    var request=JSON.parse(args[0]),uid=$.getuid();
    if(!Array.isArray(request.pids)||request.pids.length>4096||!Array.isArray(request.known)||request.known.length>16)throw Error('request');
    stage='allocate';var info=allocate(ABI.bsd),vnode=allocate(ABI.vnode),exe=allocate(ABI.exe),canonical=allocate(ABI.exe),raw=allocate(ABI.args),mib=allocate(12),size=allocate(8);
    function identity(pid){
      if($.proc_pidinfo(pid,3,0,info.address,ABI.bsd)!==ABI.bsd)throw Error('identity');
      var seconds=u64(info.bytes,ABI.seconds),micros=u64(info.bytes,ABI.micros);
      if(u32(info.bytes,ABI.pid)!==pid||u32(info.bytes,ABI.uid)!==uid||u32(info.bytes,ABI.ruid)!==uid||seconds<=0||micros>=1000000)throw Error('identity');
      return pid+':'+uid+':'+seconds+':'+micros;
    }
    function executable(pid){$.memset(exe.address,0,ABI.exe);var n=$.proc_pidpath(pid,exe.address,ABI.exe);if(n<=0||n>=ABI.exe)throw Error('executable');var value=text(exe,0,n+1);if(!absolute(value))throw Error('executable');return value;}
    function directory(pid){$.memset(vnode.address,0,ABI.vnode);if($.proc_pidinfo(pid,9,0,vnode.address,ABI.vnode)!==ABI.vnode)throw Error('cwd');var value=text(vnode,ABI.cwd,ABI.cwd+ABI.path);if(!absolute(value))throw Error('cwd');return value;}
    function argumentsFor(pid){
      $.memset(raw.address,0,ABI.args);put32(mib.bytes,0,1);put32(mib.bytes,4,49);put32(mib.bytes,8,pid);put32(size.bytes,0,ABI.args);put32(size.bytes,4,0);
      if($.sysctl(mib.address,3,raw.address,size.address,0,0)!==0)throw Error('metadata');
      var length=u64(size.bytes,0);return {length:length,parsed:parser.parse(raw.bytes,length,true,false)};
    }
    for(var index=0;index<request.pids.length;index++){
      var pid=request.pids[index];if(!Number.isSafeInteger(pid)||pid<=0)throw Error('pid');
      if($.kill(pid,0)!==0&&$.__error()[0]===3)continue;
      stage='identity';var before=identity(pid),cwd=null,loaded=null,fallback=false,tool=null,recorded=false,executablePath,name;
      stage='executable';
      try{executablePath=executable(pid);name=base(executablePath);}
      catch(error){
        stage='cwd';cwd=directory(pid);stage='arguments';loaded=argumentsFor(pid);
        stage='native-host';if(!absolute(loaded.parsed.invoked))throw Error('executable');var invokedName=base(loaded.parsed.invoked);executablePath=physical(loaded.parsed.invoked,cwd);name=base(executablePath);
        for(var f=0;f<request.known.length;f++)if(request.known[f].path===executablePath&&request.known[f].tool==='claude'){tool='claude';recorded=true;}
        if(!tool&&invokedName==='claude')tool='claude';
        if(tool!=='claude'||loaded.parsed.dispatch(1)!=='chrome-native-host')throw Error('executable');fallback=true;
      }
      for(var k=0;k<request.known.length;k++)if(request.known[k].path===executablePath){tool=request.known[k].tool;recorded=true;}
      if(['codex','claude','cursor-agent'].indexOf(name)!==-1)tool=name;
      var interpreter=request.known.length>0&&['node','nodejs','bash','sh','zsh','python','python3'].indexOf(name)!==-1;
      if(!tool&&!interpreter){if(before!==identity(pid)||executablePath!==executable(pid))throw Error('race');continue;}
      stage='cwd';if(cwd===null)cwd=directory(pid);
      stage='arguments';if(loaded===null)loaded=argumentsFor(pid);
      var length=loaded.length,parsed=loaded.parsed,dispatchStart=1;
      if(!tool&&interpreter){
        stage='script';
        var argument=parsed.script(name);
        if(argument){var script=physical(argument.value,cwd);dispatchStart=argument.index+1;
          for(var j=0;j<request.known.length;j++)if(request.known[j].path===script){tool=request.known[j].tool;recorded=true;}}
      }
      stage='projection';var environment=tool?parser.parse(raw.bytes,length,true,true).environment:null,dispatch=tool?parsed.dispatch(dispatchStart):null;
      $.memset(raw.address,0,ABI.args);
      stage='recheck';if(before!==identity(pid)||cwd!==directory(pid))throw Error('race');
      if(fallback){stage='arguments';var confirmed=argumentsFor(pid);stage='recheck';
        if(!absolute(confirmed.parsed.invoked)||physical(confirmed.parsed.invoked,cwd)!==executablePath||confirmed.parsed.dispatch(1)!=='chrome-native-host')throw Error('race');
        $.memset(raw.address,0,ABI.args);
      }else if(executablePath!==executable(pid))throw Error('race');
      if(tool)results.push({pid:pid,uid:uid,birth:before,executable:executablePath,cwd:cwd,tool:tool,recorded:recorded,dispatch:dispatch,environment:environment});
    }
    return JSON.stringify({ok:true,processes:results});
  }catch(error){return JSON.stringify({ok:false,stage:stage,pid:typeof pid==='number'?pid:null});}
  finally{for(var a=allocations.length-1;a>=0;a--){$.memset(allocations[a][0],0,allocations[a][1]);$.free(allocations[a][0]);}}
}`;

function boundedRead(file: string): Buffer {
  const buffer = Buffer.alloc(262144); let fd: number | undefined;
  try { fd = openSync(file, "r"); let length = 0, n: number;
    while ((n = readSync(fd, buffer, length, buffer.length - length, null)) > 0) { length += n; if (length === buffer.length) throw new Error("metadata bounds"); }
    return buffer.subarray(0, length);
  } catch (error) { buffer.fill(0); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function linuxProcesses(pids: number[], known: ToolExecutable[]): ToolProcessMetadata[] {
  const parser = processMetadataParser(); const uid = process.getuid!(); const results: ToolProcessMetadata[] = [];
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const snapshot = (pid: number): { birth: string; singleZombie: boolean } => {
    let status: Buffer | undefined, stat: Buffer | undefined;
    try {
      status = boundedRead(`/proc/${pid}/status`); stat = boundedRead(`/proc/${pid}/stat`);
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status.toString("utf8"));
      if (!ids || ids.slice(1).some((id) => Number(id) !== uid)) throw new Error("metadata identity");
      const text = stat.toString("utf8"); const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const start = fields[19];
      if (!text.startsWith(`${pid} (`) || !/^\d+$/.test(start ?? "")) throw new Error("metadata identity");
      const statusText = status.toString("utf8");
      const states = [...statusText.matchAll(/^State:\s+([A-Za-z])\s+\([^\r\n]+\)$/gm)];
      const threads = [...statusText.matchAll(/^Threads:\s+(\d+)$/gm)];
      if (states.length !== 1 || threads.length !== 1
        || statusText.match(/^State:/gm)?.length !== 1 || statusText.match(/^Threads:/gm)?.length !== 1
        || !/^[RSDTtXZPIWK]$/.test(states[0][1]) || !/^[RSDTtXZPIWK]$/.test(fields[0] ?? "")
        || [threads[0][1], fields[17]].some((count) => !/^[1-9]\d*$/.test(count ?? "") || !Number.isSafeInteger(Number(count)))) throw new Error("metadata identity");
      const singleZombie = states[0][1] === "Z" && fields[0] === "Z" && threads[0][1] === "1" && fields[17] === "1";
      if ((states[0][1] === "Z" || fields[0] === "Z") && !singleZombie) throw new Error("metadata identity");
      return { birth: `${pid}:${uid}:${boot}:${start}`, singleZombie };
    } finally { status?.fill(0); stat?.fill(0); }
  };
  const identity = (pid: number): string => snapshot(pid).birth;
  for (const pid of pids) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    const initial = snapshot(pid), before = initial.birth;
    // A zombie group leader may still have live subthreads. Only a twice-observed,
    // same-birth single-thread zombie is terminal; unreadable or changing metadata stays closed.
    if (initial.singleZombie) {
      const confirmed = snapshot(pid);
      if (confirmed.birth !== before || !confirmed.singleZombie) throw new Error("metadata race");
      continue;
    }
    const executable = readlinkSync(`/proc/${pid}/exe`), name = path.basename(executable);
    let tool = known.find((item) => item.path === executable)?.tool;
    let recorded = tool !== undefined;
    if (["codex", "claude", "cursor-agent"].includes(name)) tool = name as Tool;
    const interpreter = known.length > 0 && ["node", "nodejs", "bash", "sh", "zsh", "python", "python3"].includes(name);
    if (!tool && !interpreter) { if (before !== identity(pid) || executable !== readlinkSync(`/proc/${pid}/exe`)) throw new Error("metadata race"); continue; }
    const cwd = readlinkSync(`/proc/${pid}/cwd`); let args: Buffer | undefined, raw: Buffer | undefined;
    try {
      args = boundedRead(`/proc/${pid}/cmdline`);
      const parsed = parser.parse(args, args.length, false, false); let dispatchStart = 1;
      if (interpreter && !tool) {
        const argument = parsed.script(name);
        if (argument) {
          const script = realpathSync(path.resolve(cwd, argument.value)); dispatchStart = argument.index + 1;
          tool = known.find((item) => item.path === script)?.tool;
          recorded = tool !== undefined;
        }
      }
      let environment: ToolProcessMetadata["environment"] = {};
      if (tool) { raw = boundedRead(`/proc/${pid}/environ`); environment = parser.parse(raw, raw.length, false, true).environment; }
      if (before !== identity(pid) || executable !== readlinkSync(`/proc/${pid}/exe`) || cwd !== readlinkSync(`/proc/${pid}/cwd`)) throw new Error("metadata race");
      if (tool) results.push({ pid, uid, birth: before, executable, cwd, tool, recorded, dispatch: parsed.dispatch(dispatchStart), environment });
    } finally { args?.fill(0); raw?.fill(0); }
  }
  return results;
}

/** Undefined is a closed/unknown result, never permission to activate. No raw stderr is exposed. */
export function readToolProcessMetadata(pids: number[], known: ToolExecutable[]): ToolProcessMetadata[] | undefined {
  try {
    if (!process.getuid || pids.length > 4096 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) || new Set(pids).size !== pids.length) return undefined;
    if (known.length > 16 || known.some((item) => !path.isAbsolute(item.path) || !["codex", "claude", "cursor-agent"].includes(item.tool))) return undefined;
    known = known.map((item) => ({ ...item, path: realpathSync(item.path) }));
    let result;
    if (process.platform === "linux") result = { ok: true, processes: linuxProcesses(pids, known) };
    else {
      if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) return undefined;
      const program = darwinProgram.replace("PARSER()", `(${processMetadataParser.toString()})()`);
      const output = childProcess.execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", program, JSON.stringify({ pids, known })], {
        encoding: "utf8", timeout: 8_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
      });
      result = JSON.parse(output);
    }
    if (result.ok !== true || !Array.isArray(result.processes) || result.processes.length > pids.length) return undefined;
    const seen = new Set<number>();
    for (const item of result.processes) {
      if (!pids.includes(item.pid) || seen.has(item.pid) || item.uid !== process.getuid() || typeof item.birth !== "string"
        || !item.birth.startsWith(`${item.pid}:${item.uid}:`) || item.birth.length > 256 || !/^[0-9a-f:-]+$/.test(item.birth)
        || typeof item.recorded !== "boolean" || !["codex", "claude", "cursor-agent"].includes(item.tool)
        || !["ordinary", "chrome-native-host"].includes(item.dispatch)
        || typeof item.cwd !== "string" || !path.isAbsolute(item.cwd) || typeof item.executable !== "string" || !path.isAbsolute(item.executable)
        || !item.environment || typeof item.environment !== "object" || Array.isArray(item.environment)
        || Object.keys(item).some((key) => !["pid", "uid", "birth", "executable", "cwd", "tool", "recorded", "dispatch", "environment"].includes(key))
        || [item.cwd, item.executable].some((value) => value.length >= 4096 || /[\0\r\n]/.test(value))) return undefined;
      seen.add(item.pid);
      for (const [key, value] of Object.entries(item.environment)) {
        if (!["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key) || typeof value !== "string" || value.length > 16384 || /[\0\r\n]/.test(value)) return undefined;
      }
    }
    return result.processes;
  } catch { return undefined; }
}
