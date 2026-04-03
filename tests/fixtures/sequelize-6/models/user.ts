import { Model, DataTypes, Sequelize } from 'sequelize';

class User extends Model {
  static associate(models: any) {
    User.hasMany(models.Post, { foreignKey: 'userId', as: 'posts' });
    User.belongsTo(models.Role, { foreignKey: 'roleId' });
    User.belongsToMany(models.Project, { through: 'UserProjects' });
    User.hasOne(models.Profile);
  }
}

User.init({
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, unique: true, validate: { isEmail: true } },
  roleId: { type: DataTypes.INTEGER, references: { model: 'roles', key: 'id' } },
}, {
  sequelize,
  tableName: 'users',
  paranoid: true,
  timestamps: true,
});

User.beforeCreate(async (user: any) => {
  user.password = 'hashed';
});

export default User;
