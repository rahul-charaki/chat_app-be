require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const socketio = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Models
const Message = require('./models/Message');
const User = require('./models/User');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Socket.io setup
const io = socketio(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = 'uploads/';
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs and Word documents are allowed'));
    }
  }
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Store user data with socket
  let currentUser = null;
  let currentRooms = [];

  // Authenticate socket
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      currentUser = decoded.id;
      
      // Update user status and socket ID
      await User.findByIdAndUpdate(currentUser, { 
        isOnline: true, 
        lastSeen: new Date(),
        socketId: socket.id
      });
  
      // Join user to their personal room
      socket.join(currentUser);
      currentRooms.push(currentUser);
  
      // Notify others this user is online
      io.emit('userOnline', currentUser);
    } catch (err) {
      console.error('Socket authentication error:', err);
      socket.emit('error', { message: 'Authentication failed' });
    }
  });
  

  // Join a room
  socket.on('joinRoom', async ({ room }) => {
    if (!currentUser) return;

    try {
      // Leave previous rooms (except private rooms)
      currentRooms.forEach(r => {
        if (!r.includes('_')) { // Only leave non-private rooms
          socket.leave(r);
          currentRooms = currentRooms.filter(room => room !== r);
        }
      });

      // Join new room
      socket.join(room);
      currentRooms.push(room);
      console.log(`User ${currentUser} joined room: ${room}`);
    } catch (err) {
      console.error('Room join error:', err);
    }
  });

  // Send message to room
  socket.on('sendMessage', async ({ room, message, file }) => {
    if (!currentUser) return;

    try {
      const user = await User.findById(currentUser);
      if (!user) return;

      const newMessage = new Message({
        sender: currentUser,
        username: user.username,
        room,
        message,
        file,
        isPrivate: false
      });

      await newMessage.save();
      io.to(room).emit('receiveMessage', newMessage);
    } catch (err) {
      console.error('Message send error:', err);
    }
  });

  // Send private message
  socket.on('sendPrivateMessage', async ({ recipientId, message, file }) => {
    if (!currentUser) return;
  
    try {
      const [sender, recipient] = await Promise.all([
        User.findById(currentUser),
        User.findById(recipientId)
      ]);
  
      if (!sender || !recipient) {
        throw new Error('Sender or recipient not found');
      }
  
      const conversationId = [currentUser, recipientId].sort().join('_');
      const newMessage = new Message({
        sender: currentUser,
        recipient: recipientId,
        username: sender.username,
        message,
        file,
        isPrivate: true,
        conversationId
      });
  
      await newMessage.save();
  
      // Create message payload with populated sender data
      const messagePayload = await Message.populate(newMessage, {
        path: 'sender',
        select: 'username avatar'
      });
  
      // Emit to sender
      socket.emit('receivePrivateMessage', messagePayload);
  
      // Check if recipient is online and has active socket
      const recipientUser = await User.findById(recipientId);
      if (recipientUser && recipientUser.socketId) {
        // Emit to recipient if online
        io.to(recipientUser.socketId).emit('receivePrivateMessage', messagePayload);
      }
    } catch (err) {
      console.error('Private message error:', err);
      socket.emit('error', { message: 'Failed to send private message' });
    }
  });

  // Typing indicator
  socket.on('typing', async ({ room, isTyping }) => {
    if (!currentUser) return;

    try {
      const user = await User.findById(currentUser);
      if (!user) return;

      if (isTyping) {
        socket.to(room).emit('typing', { userId: currentUser, username: user.username });
      } else {
        socket.to(room).emit('stopTyping', currentUser);
      }
    } catch (err) {
      console.error('Typing indicator error:', err);
    }
  });

  // Add reaction to message
  socket.on('addReaction', async ({ messageId, emoji }) => {
    if (!currentUser) return;

    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      // Remove existing reaction from this user
      message.reactions = message.reactions.filter(
        r => r.userId.toString() !== currentUser.toString()
      );

      // Add new reaction
      message.reactions.push({ userId: currentUser, emoji });
      await message.save();

      // Broadcast updated message
      if (message.isPrivate) {
        io.to(message.sender.toString())
          .to(message.recipient.toString())
          .emit('messageUpdated', message);
      } else {
        io.to(message.room).emit('messageUpdated', message);
      }
    } catch (err) {
      console.error('Reaction error:', err);
    }
  });

  // Update the disconnect handler
  socket.on('disconnect', async () => {
    if (currentUser) {
      try {
        // Only mark offline if no other sockets for this user exist
        const userSockets = await io.in(currentUser).fetchSockets();
        if (userSockets.length === 0) {
          await User.findByIdAndUpdate(currentUser, { 
            isOnline: false, 
            lastSeen: new Date(),
            socketId: null
          });
          io.emit('userOffline', currentUser);
        }
      } catch (err) {
        console.error('Disconnect error:', err);
      }
    }
  });
});

// API Routes

// Auth routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Get messages for a room
app.get('/api/messages/:room', async (req, res) => {
    try {
      const messages = await Message.find({ 
        room: req.params.room,
        isPrivate: false 
      })
      .sort({ timestamp: 1 }) // Sort by oldest first for proper display
      .limit(50)
      .populate('sender', 'username avatar')
      .populate('reactions.userId', 'username')
      .exec();
  
      res.json(messages);
    } catch (err) {
      console.error('Error fetching room messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });
  
  // Get private messages for a conversation
  app.get('/api/messages/private/:conversationId', async (req, res) => {
    try {
      const messages = await Message.find({ 
        conversationId: req.params.conversationId 
      })
      .sort({ timestamp: 1 }) // Sort by oldest first for proper display
      .limit(50)
      .populate('sender', 'username avatar')
      .populate('recipient', 'username avatar')
      .populate('reactions.userId', 'username')
      .exec();
  
      res.json(messages);
    } catch (err) {
      console.error('Error fetching private messages:', err);
      res.status(500).json({ error: 'Failed to fetch private messages' });
    }
  });

// Search messages
app.get('/api/messages/search', async (req, res) => {
  try {
    const { query, room } = req.query;
    if (!query || !room) {
      return res.status(400).json({ error: 'Query and room parameters are required' });
    }

    const messages = await Message.find({
      room,
      isPrivate: false,
      message: { $regex: query, $options: 'i' }
    })
    .sort({ timestamp: -1 })
    .limit(20)
    .populate('sender', 'username avatar')
    .exec();

    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, 'username avatar isOnline lastSeen')
      .sort({ username: 1 })
      .exec();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    res.json({
      path: req.file.path,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.io server connected`);
});