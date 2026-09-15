import fs from 'node:fs';
fs.mkdirSync('dist/server',{recursive:true});
fs.copyFileSync('src/worker.js','dist/server/index.js');
fs.copyFileSync('src/relay.js','dist/server/relay.js');
fs.mkdirSync('dist/.openai',{recursive:true});
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
console.log('Public link service built.');
