import mongoose, { Schema } from 'mongoose';

const postSchema = new Schema({
  title: { type: String, required: true },
  body: String,
  author: { type: Schema.Types.ObjectId, ref: 'User' },
  tags: [String],
  published: { type: Boolean, default: false },
}, { timestamps: true });

postSchema.index({ title: 1, author: 1 });

postSchema.pre('find', function() {
  this.populate('author');
});

export const Post = mongoose.model('Post', postSchema);
