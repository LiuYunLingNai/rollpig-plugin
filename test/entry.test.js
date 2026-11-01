import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, cp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const plugin = fileURLToPath(new URL('../', import.meta.url));
const oldFramework = resolve(plugin, '../..');

test('legacy root entry loads shared gameplay without NG while preserving existing fixture players and config', {
  skip: !existsSync(join(oldFramework, 'lib/plugins/plugin.js')) && '需要旧云崽框架目录进行根入口检查',
}, async () => {
  const temp = join(oldFramework, 'temp');
  await mkdir(temp, { recursive: true });
  const home = await mkdtemp(join(temp, 'rollpig-dual-entry-'));
  try {
    await mkdir(join(home, 'lib/config'), { recursive: true });
    await mkdir(join(home, 'lib/plugins'), { recursive: true });
    await mkdir(join(home, 'lib/puppeteer'), { recursive: true });
    await mkdir(join(home, 'plugins/rollpig-plugin'), { recursive: true });
    await symlink(join(oldFramework, 'node_modules'), join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(home, 'package.json'), '{"type":"module"}');
    await writeFile(join(home, 'lib/config/config.js'), 'export default { masterQQ: ["10001"] };');
    await cp(join(oldFramework, 'lib/plugins/plugin.js'), join(home, 'lib/plugins/plugin.js'));
    await writeFile(join(home, 'lib/puppeteer/puppeteer.js'), 'export default { async screenshot(name, data) { globalThis.__shots.push({name, data}); return globalThis.segment.image(Buffer.from("legacy-render")); } };');
    const dest = join(home, 'plugins/rollpig-plugin');
    for (const name of ['index.js', 'package.json', 'host', 'ng', 'apps', 'lib', 'constants', 'resource']) {
      await cp(join(plugin, name), join(dest, name), { recursive: true });
    }
    await mkdir(join(dest, 'config/default_config'), { recursive: true });
    await cp(join(plugin, 'config/default_config/config.yaml'), join(dest, 'config/default_config/config.yaml'));
    await mkdir(join(dest, 'config/config'), { recursive: true });
    const userConfig = 'pighub_enabled: false\nqqbot_markdown_enabled: false\nai_enabled: false\n';
    await writeFile(join(dest, 'config/config/config.yaml'), userConfig);
    await mkdir(join(dest, 'data'), { recursive: true });
    const initialData = JSON.stringify({ history: {}, collection: { 'old-user': ['1'] }, user_names: {} });
    await writeFile(join(dest, 'data/pig_data.json'), initialData);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const root = process.argv[1];
      const sent = []; globalThis.__shots = [];
      globalThis.logger = Object.fromEntries(['debug','info','warn','error'].map(level => [level, () => {}]));
      globalThis.fetch = () => { throw new Error('Unexpected real network request'); };
      globalThis.segment = {
        image: file => ({type:'image',file}), at: qq => ({type:'at',qq}),
        button: (...rows) => ({type:'button',data:rows}), reply: id => ({type:'reply',id})
      };
      const members = new Map(['10001','10002','10003'].map(user_id => [user_id, {user_id,nickname:'玩家'+user_id,role:'member'}]));
      const group = {group_id:'70001',info:{group_id:'70001',group_name:'测试群'},
        pickMember: uid => ({info:members.get(String(uid))}), getMemberMap: async () => members,
        sendMsg: async content => {const result={message_id:'send-'+(sent.length+1)};sent.push({content,result});return result;}}
      const bot = {uin:'90001',adapter:'icqq',online:true,gl:new Map([['70001',group.info]]),
        pickGroup: () => group, pickFriend: () => ({sendMsg:group.sendMsg})};
      globalThis.Bot = bot;
      const {apps} = await import(pathToFileURL(path.join(root,'index.js')).href);
      const host = await import(pathToFileURL(path.join(root,'host/index.js')).href);
      const config = await import(pathToFileURL(path.join(root,'lib/model/config.js')).href);
      const {default:store} = await import(pathToFileURL(path.join(root,'lib/store/store.js')).href);
      assert.equal(Object.keys(apps).length,7);
      assert.deepEqual(store.data.collection['old-user'],['1']);
      assert.equal(host.hostKind(),'trss');
      const commands=Object.values(apps).map(App=>new App()).sort((a,b)=>a.priority-b.priority);
      async function command(text,uid='10001',extra={}){
        const event={msg:text,user_id:uid,self_id:'90001',group_id:'70001',isGroup:true,isMaster:uid==='10001',
          bot,group,sender:{user_id:uid,nickname:'玩家'+uid,role:'member'},message:[{type:'text',text}],
          reply:async(content,quote,opts)=>{const result={message_id:'reply-'+(sent.length+1)};sent.push({content,quote,opts,result});return result;},...extra};
        const beforeReply=event.reply;
        for(const app of commands){app.e=event;const rule=app.rule.find(rule=>new RegExp(rule.reg).test(text));
          if(rule&&await app[rule.fnc]()){assert.equal(event.reply,beforeReply);return sent.at(-1);}}
        return null;
      }
      try{
        for(const cmd of ['今日小猪','小猪图鉴','昨日小猪','本周小猪','小猪日报']){
          const msg=await command(cmd);assert(msg.content.some(item=>item.type==='image'),cmd);
        }
        assert.equal(globalThis.__shots.length,5);
        assert.deepEqual(globalThis.__shots.map(shot=>shot.name),['rollpig-card','rollpig-catalog','rollpig-yesterday','rollpig-weekly','rollpig-daily-report']);
        assert(globalThis.__shots.every(shot=>shot.data.tplFile.startsWith(root)));
        assert(globalThis.__shots.every(shot=>!('viewport' in shot.data)&&!('selector' in shot.data)&&!('imgType' in shot.data)&&!('saveId' in shot.data)));
        const date=Object.keys(store.data.history)[0],pig=store.data.history[date]['10001'];
        const copies=store.data.pig_progress['10001'][pig].copies;
        await command('#今日小猪');assert.equal(store.data.pig_progress['10001'][pig].copies,copies);
        const denied=await command('日报状态 开启','10002');assert(denied.content.some(item=>item.text?.includes('只有')));
        await command('今日小猪','10002');
        const notification=await command('烤群友','10001',{message:[{type:'text',text:'烤群友'},{type:'at',qq:'10003'}]});
        const reservation=Object.values(store.data.roast_reservations)[0];assert(reservation);
        assert(reservation.messages.some(msg=>msg.message_id===notification.result.message_id));
        await command('加入','10002',{source:{message_id:notification.result.message_id,user_id:'90001'}});
        assert.equal(reservation.participants.length,2);
        await command('今日小猪','10003');assert.equal(reservation.status,'completed');
        assert.equal(await fs.readFile(path.join(root,'config/config/config.yaml'),'utf8'),${JSON.stringify(userConfig)});
        console.log('TRSS root smoke: 7 apps, 5 renders, unchanged user config, repeat draw, permissions and reservation delivery OK');
      }finally{await host.getContext().dispose();await host.waitForOperations();}
    `, dest], { env, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(join(dest, 'config/config/config.yaml'), 'utf8'), userConfig);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
