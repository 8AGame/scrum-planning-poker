const app = require('express')();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const cards = require('./cards');
const { formatNumber, formatTimer } = require('./util');

const port = process.env.PORT || 9001;
const debug = !(process.env.PROD || false);
const log = debug ? (...args) => console.log(...args) : () => { };

const emit = (socket, room, keys = null) => {
  let payload = { id: room.id };
  const { players, ...rest } = room;

  const toPlayers = () => players.map((player, index) => {
    const score = player.score === null ? '' : cards.find(c => c.value === player.score).key;
    const needAnnoymous = !room.isNoymous && !socket.isHost && socket.nickName !== player.nickName;
    const nickName = needAnnoymous ? `Player ${index + 1}` : player.nickName;
    const avatarUrl = needAnnoymous ? '' : player.avatarUrl;
    return { score, nickName, avatarUrl };
  })


  rest.players = players.map((player, index) => {
    const score = player.score === null ? '' : cards.find(c => c.value === player.score).key;
    const needAnnoymous = !room.isNoymous && !socket.isHost && socket.nickName !== player.nickName;
    const nickName = needAnnoymous ? `Player ${index + 1}` : player.nickName;
    const avatarUrl = needAnnoymous ? '' : player.avatarUrl;
    return { score, nickName, avatarUrl };
  });

  if (keys) {
    if (keys.toString() === '[object Set]') {
      keys = Array.from(keys);
    }

    if (keys.length) {
      keys.forEach(key => {
        switch (key) {
          case 'players': payload[key] = toPlayers(); break;
          default: payload[key] = rest[key]; break;
        }
      });
      log('[emit]', payload);
      socket.emit('action', payload);
    }
  } else {
    for (const key in room) {
      if (room.hasOwnProperty(key) && !key.startsWith('_')) {
        switch (key) {
          case 'players': payload[key] = toPlayers(); break;
          default: payload[key] = rest[key]; break;
        }
      }
    }

    payload.init = true;
    payload.cards = cards;
    payload.calcMethods = [
      'Arithmetic Mean',
      'Truncated Mean',
    ];
    payload.info1 = 'Voting...';
    payload.info2 = 'All Stories';
    payload.inviteIconUrl = '../../image/invite-black.png';
    payload.shareImageUrl = '../../image/invite-photo.png';

    const player = players.find(i => i.nickName === socket.nickName);
    payload.selectedCard = player ? player.score : null;

    log('[init]', payload);
    socket.emit('init', payload);
  }
};

const emitAll = (room, keys) => {
  room._sockets.forEach(socket => emit(socket, room, keys));
};

const error = (socket, msg) => {
  log('[error]', msg);
  socket.error(msg);
};

const calculator = (room) => {
  console.log(room);
};

if (debug) {
  app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
  });

  app.get('/host', (req, res) => {
    res.sendFile(__dirname + '/host.html');
  });

  app.get('/player', (req, res) => {
    res.sendFile(__dirname + '/player.html');
  });
}

// rooms dictionary
const rooms = {};

io.on('connection', (socket) => {
  log('a user connected');

  socket.on('create room', ({ stories, ...room }) => {
    log('[create room]', { stories, ...room });
    if (rooms.hasOwnProperty(room.id)) return error(socket, 'Room is duplicated!');

    room._stories = decodeURIComponent(stories).split('\n').filter(i => i);
    room._sockets = new Set();
    room._interval = null;
    room._storyIndex = -1;
    room._timer = 0;
    room.players = [];
    room.scores = [];
    room.currentStory = '';
    room.loading = false;
    room.start = false;
    room.finished = room._stories.length === 0;
    room.hasNext = room._stories.length > 1;
    room.displayTime = '00:00:00';
    room.calcMethod = 0;
    room.averageScore = '';
    room.medianScore = '';
    rooms[room.id] = room;
  });

  socket.on('next story', ({ id, resultType, stories }) => {
    log('[next story]', { id, resultType, stories });
    if (!rooms.hasOwnProperty(id)) return error(socket, 'Room has been deleted!');
    const room = rooms[id];
    const keys = new Set();;

    // push new stories
    if (stories) decodeURIComponent(stories).split('\n').forEach(i => i && room._stories.push(i));

    if (room._storyIndex !== -1) {
      // save scores
      room.scores.push({
        name: room.currentStory,
        time: room.displayTime,
        score: resultType === 0 ? room.averageScore : room.medianScore
      });
      keys.add('scores');
    } else {
      room.start = true;
      keys.add('start');
      room._interval = setInterval(() => {
        room._timer++;
        room.displayTime = formatTimer(room._timer);
        emitAll(room, ['displayTime']);
      }, 1000);
    }

    room._storyIndex++;
    room._timer = 0;

    const { length } = room._stories;
    if (length > room._storyIndex) {
      if (room.hasNext !== ((length - 1) > room._storyIndex)) {
        room.hasNext = !room.hasNext;
        keys.add('hasNext');
      }

      room.currentStory = room._stories[room._storyIndex];
      keys.add('currentStory');
    } else {
      if (room._interval) {
        clearInterval(room._interval);
      }

      room.start = false;
      keys.add('start');
      room.finished = true;
      keys.add('finished');
      room.displayTime = '00:00:00';
      keys.add('displayTime');
      room.currentStory = 'Congratulations!';
      keys.add('currentStory');
    }

    room.loading = false;
    keys.add('loading');

    emitAll(room, keys);
  });

  socket.on('join room', ({ id, userInfo, isHost }) => {
    log('[join room]', { id, userInfo, isHost });
    if (!rooms.hasOwnProperty(id)) return error(socket, 'Room has been deleted!');
    const room = rooms[id];
    room._sockets.add(socket);
    socket.nickName = userInfo.nickName;
    socket.isHost = isHost;
    emit(socket, room);
    if (!room.needScore && isHost) return;
    if (room.players.findIndex(({ nickName }) => userInfo.nickName === nickName) === -1) {
      const player = { ...userInfo };
      player.score = null;
      room.players.push(player);
      emitAll(room, ['players']);
    }
  });

  socket.on('select card', ({ id, card }) => {
    log('[select card]', { id, card });
    if (!rooms.hasOwnProperty(id)) return error(socket, 'Room has been deleted!');
    if (!socket.nickName) return error(socket, 'Did join the room');
    const room = rooms[id];
    const player = room.players.find(p => p.nickName === socket.nickName);
    if (player) {
      player.score = card ? card.value : null;
      calculator(room);
      emitAll(room, ['players', 'averageScore', 'medianScore']);
    }
  });

  socket.on('calc method', ({ id, calcMethod }) => {
    log('[calc method]', { id, calcMethod });
    if (!rooms.hasOwnProperty(id)) return error(socket, 'Room has been deleted!');
    const room = rooms[id];
    calculator(room);
    emitAll(room, ['averageScore', 'medianScore']);
  });

  socket.on('disconnect', () => {
    for (const key in rooms) {
      if (rooms.hasOwnProperty(key)) {
        const room = rooms[key];
        if (room._sockets.has(socket)) {
          room._sockets.delete(socket);
          const findIndex = room.players.findIndex(p => p.nickName === socket.nickName);
          if (findIndex !== -1 && room.players[findIndex].score === null) {
            room.players.splice(findIndex, 1);
            emitAll(room, ['players']);
          }
        }
      }
    }
  });

  if (debug) {
    socket.on('chat message', function (msg) {
      io.emit('chat message', msg);
    });
  }
});

http.listen(port, () => {
  log(`listening on *:${port}`);
});