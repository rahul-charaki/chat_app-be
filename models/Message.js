const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  username: {
    type: String,
    required: true
  },
  room: {
    type: String
  },
  message: {
    type: String,
    required: true
  },
  file: {
    path: String,
    originalname: String,
    mimetype: String,
    size: Number
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  conversationId: {
    type: String,
    index: true
  },
  reactions: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    emoji: String
  }],
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Add indexes for better performance
messageSchema.index({ room: 1, timestamp: 1 });
messageSchema.index({ conversationId: 1, timestamp: 1 });
messageSchema.index({ sender: 1, recipient: 1 });

module.exports = mongoose.model('Message', messageSchema);