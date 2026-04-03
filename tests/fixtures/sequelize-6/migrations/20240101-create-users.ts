module.exports = {
  up: async (queryInterface: any, Sequelize: any) => {
    await queryInterface.createTable('users', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false },
      roleId: { type: Sequelize.INTEGER, references: { model: 'roles', key: 'id' } },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
      deletedAt: { type: Sequelize.DATE },
    });
    await queryInterface.addIndex('users', ['email']);
  },
  down: async (queryInterface: any) => {
    await queryInterface.dropTable('users');
  },
};
