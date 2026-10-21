const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data.json');

// ===================== 数据存储 =====================
// sessions: { sessionId: { id, createdAt, messages: [], unread: 0 } }
let sessions = {};
let autoReplyEnabled = true;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (d.sessions) sessions = d.sessions;
      if (typeof d.autoReplyEnabled === 'boolean') autoReplyEnabled = d.autoReplyEnabled;
    }
  } catch (e) { console.error('读取数据失败：', e.message); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ sessions, autoReplyEnabled }, null, 2));
  } catch (e) { console.error('保存数据失败：', e.message); }
}

// ===================== 自动回复 =====================
const AUTO_REPLY = [
  { keys: ['你好', '您好', 'hi', 'hello', '在吗', '在么'], reply: '您好呀～我是您的专属客服，很高兴为您服务！请问有什么可以帮您的？😊' },
  { keys: ['价格', '多少钱', '费用', '收费'], reply: '关于价格，请提供您想咨询的商品/服务名称，我帮您查询具体报价哦～' },
  { keys: ['退款', '退货', '售后'], reply: '退款/退货请在「我的订单」中选择对应订单申请，一般 3-5 个工作日到账。需要我帮您跟进吗？' },
  { keys: ['发货', '物流', '快递', '多久到'], reply: '商品下单后 24 小时内发货，物流信息可在订单详情实时查看。请提供订单号，我帮您查一下～' },
  { keys: ['人工', '转人工', '真人'], reply: '已为您转接人工客服，请稍等～ 💁‍♀️' },
  { keys: ['投诉', '建议', '反馈'], reply: '感谢您的反馈！我们会认真记录并改进，非常抱歉给您带来不便。🙏' },
  { keys: ['谢谢', '感谢', '辛苦'], reply: '不客气～能帮到您我很开心！还有其他问题随时找我哦 😄' }
];

const FALLBACK_REPLIES = [
  '收到您的消息啦～我马上帮您处理，请稍等。😊',
  '明白您的需求了，正在为您查询相关信息，请稍候～',
  '好的，这个问题我帮您记下了，会尽快给您答复。💪',
  '正在处理中，有任何进展我会第一时间告诉您哦～'
];

function findReply(text) {
  const t = String(text).toLowerCase();
  for (const rule of AUTO_REPLY) {
    if (rule.keys.some(k => t.includes(k.toLowerCase()))) return rule.reply;
  }
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

// ===================== 会话管理 =====================
function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { id: sessionId, createdAt: new Date().toISOString(), messages: [], unread: 0 };
  }
  return sessions[sessionId];
}

function addMessage(sessionId, msg) {
  const session = getOrCreateSession(sessionId);
  session.messages.push(msg);
  saveData();
  return msg;
}

function sessionSummary(s) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    lastMessage: s.messages.length ? s.messages[s.messages.length - 1] : null,
    messageCount: s.messages.length,
    unread: s.unread || 0
  };
}

// ===================== 路由 =====================
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: 'admin-token-' + ADMIN_PASSWORD });
  } else {
    res.status(401).json({ ok: false, error: '密码错误' });
  }
});

app.get('/api/sessions', (req, res) => {
  res.json(Object.values(sessions).map(sessionSummary));
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: '会话不存在' });
  session.unread = 0;
  saveData();
  res.json(session);
});

app.get('/api/auto-reply', (req, res) => {
  res.json({ enabled: autoReplyEnabled });
});

app.post('/api/auto-reply', (req, res) => {
  autoReplyEnabled = !!req.body.enabled;
  saveData();
  res.json({ enabled: autoReplyEnabled });
});

// ===================== Socket.IO =====================
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const sessionId = (data && data.sessionId) ? String(data.sessionId) : socket.id;
    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.role = 'user';
    const session = getOrCreateSession(sessionId);
    socket.emit('session', session);
    io.to('admin').emit('session:list', Object.values(sessions).map(sessionSummary));
  });

  socket.on('admin:join', (data) => {
    if ((data && data.password) !== ADMIN_PASSWORD) {
      socket.emit('admin:auth', { ok: false });
      return;
    }
    socket.join('admin');
    socket.data.role = 'admin';
    socket.emit('admin:auth', { ok: true });
    socket.emit('session:list', Object.values(sessions).map(sessionSummary));
    socket.emit('auto-reply', { enabled: autoReplyEnabled });
  });

  socket.on('message', (data) => {
    const sessionId = String((data && data.sessionId) || socket.data.sessionId || socket.id);
    const text = String((data && data.text) || '').trim();
    if (!text) return;

    const msg = addMessage(sessionId, {
      from: 'user',
      type: (data && data.type) || 'text',
      content: text,
      time: new Date().toISOString()
    });
    sessions[sessionId].unread = (sessions[sessionId].unread || 0) + 1;
    saveData();

    io.to(sessionId).emit('message', msg);
    io.to('admin').emit('message:new', { sessionId, message: msg });
    io.to('admin').emit('session:list', Object.values(sessions).map(sessionSummary));

    if (autoReplyEnabled) {
      setTimeout(() => {
        const botMsg = addMessage(sessionId, {
          from: 'service',
          type: 'text',
          content: findReply(text),
          time: new Date().toISOString()
        });
        io.to(sessionId).emit('message', botMsg);
        io.to('admin').emit('message:new', { sessionId, message: botMsg });
        io.to('admin').emit('session:list', Object.values(sessions).map(sessionSummary));
      }, 600 + Math.random() * 800);
    }
  });

  socket.on('admin:reply', (data) => {
    const sessionId = String((data && data.sessionId) || '');
    const text = String((data && data.text) || '').trim();
    if (!sessionId || !text) return;
    const msg = addMessage(sessionId, {
      from: 'service',
      type: 'text',
      content: text,
      time: new Date().toISOString()
    });
    io.to(sessionId).emit('message', msg);
    io.to('admin').emit('message:new', { sessionId, message: msg });
    io.to('admin').emit('session:list', Object.values(sessions).map(sessionSummary));
  });

  socket.on('admin:set-auto-reply', (data) => {
    autoReplyEnabled = !!data.enabled;
    saveData();
    io.to('admin').emit('auto-reply', { enabled: autoReplyEnabled });
  });

  socket.on('disconnect', () => {});
});

// ===================== 启动 =====================
loadData();
server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  H5 在线客服系统已启动');
  console.log('  用户端:     http://localhost:' + PORT);
  console.log('  客服工作台: http://localhost:' + PORT + '/admin');
  console.log('  客服密码:   ' + ADMIN_PASSWORD);
  console.log('==============================================');
});
