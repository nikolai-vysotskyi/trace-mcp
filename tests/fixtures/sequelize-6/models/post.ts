import { Model, DataTypes } from 'sequelize';

class Post extends Model {
  static associate(models: any) {
    Post.belongsTo(models.User, { foreignKey: 'userId' });
  }
}

Post.init({
  title: { type: DataTypes.STRING, allowNull: false },
  body: DataTypes.TEXT,
  userId: { type: DataTypes.INTEGER, references: { model: 'users', key: 'id' } },
  published: { type: DataTypes.BOOLEAN, allowNull: false },
}, {
  sequelize,
  tableName: 'posts',
  timestamps: true,
});

export default Post;
