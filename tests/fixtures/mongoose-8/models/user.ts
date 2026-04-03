import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, index: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
  profile: { type: Schema.Types.ObjectId, ref: 'Profile' },
  address: {
    street: String,
    city: String,
  },
}, { timestamps: true, collection: 'users' });

userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

userSchema.virtual('recentPosts', {
  ref: 'Post',
  localField: '_id',
  foreignField: 'author',
});

userSchema.pre('save', function(next) {
  // hash password
  next();
});

userSchema.post('save', function(doc) {
  // log save
});

userSchema.methods.comparePassword = async function(candidate: string) {
  return false;
};

userSchema.statics.findByEmail = function(email: string) {
  return this.findOne({ email });
};

userSchema.plugin(mongoosePaginate);
userSchema.index({ email: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);
