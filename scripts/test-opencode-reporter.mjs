import assert from "node:assert/strict";
import test from "node:test";
import { reportFor, supportsReporter } from "../integrations/opencode/tui.js";

test("the compatibility reporter is scoped to OpenCode 2.0.25 in a Herdr TTY", () => {
  const host = { app: { version: "2.0.25" } }, env = { HC_TERMINAL_ID: "t7" };
  assert.equal(supportsReporter(host, env, {isTTY:true}), true);
  assert.equal(supportsReporter(host, {}, {isTTY:true}), false);
  assert.equal(supportsReporter(host, env, {isTTY:false}), false);
  for (const version of ["1.0.0", "2.0.26", undefined]) {
    assert.equal(supportsReporter({app:{version}}, env, {isTTY:true}), false);
  }
});

test("OSC reports follow the selected session through work, questions, completion and navigation", () => {
  let route = {type:"home"};
  const active = {title:"Repair the bridge", outcome:undefined, status:"idle", pending:[], forms:[], permissions:[], messages:[]};
  const other = {...active, title:"Other session", status:"running", permissions:[{}]};
  const sessions = {a:active,b:other};
  const context = {ui:{router:{current:() => route}},data:{session:{
    get:id => sessions[id], status:id => sessions[id].status,
    pending:{list:id => sessions[id].pending}, form:{list:id => sessions[id].forms},
    permission:{list:id => sessions[id].permissions}, message:{list:id => sessions[id].messages},
  }}};
  const fields = () => {
    const osc = reportFor(context);
    assert.ok(osc.startsWith("\x1b]7501;") && osc.endsWith("\x1b\\"));
    return Object.fromEntries(osc.slice(7,-2).split(":").map(field => {
      const eq=field.indexOf("=");
      return [field.slice(0,eq),field.slice(eq+1)];
    }));
  };
  assert.deepEqual(fields(),{state:"idle",app:"opencode"});
  route={type:"session",sessionID:"a"};
  assert.equal(fields().state,"idle");
  active.pending=[{type:"synthetic"}]; assert.equal(fields().state,"idle");
  active.pending=[{type:"user"}]; assert.equal(fields().state,"working");
  active.pending=[]; active.status="running"; assert.equal(fields().state,"working");
  active.forms=[{}]; assert.equal(fields().kind,"question");
  active.permissions=[{}]; assert.equal(fields().kind,"permission");
  active.permissions=[]; active.forms=[]; assert.equal(fields().state,"working");
  active.status="idle"; active.messages=[{type:"idle",outcome:"failed"}]; assert.equal(fields().state,"error");
  route={type:"session",sessionID:"b"};
  assert.equal(fields().state,"blocked");
  assert.equal(Buffer.from(fields().title,"base64").toString(),"Other session");
  route={type:"session",sessionID:"a"}; active.messages=[]; active.outcome="succeeded";
  assert.equal(fields().state,"done");
  active.messages=[{type:"idle",outcome:"interrupted"}]; assert.equal(fields().state,"done");
  active.title="Title:\x1b]7501;state=error\x07🛡";
  assert.equal(Buffer.from(fields().title,"base64").toString(),"Title: ]7501;state=error 🛡");
  route={type:"home"}; assert.deepEqual(fields(),{state:"idle",app:"opencode"});
});
