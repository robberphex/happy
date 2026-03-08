export default function defineAuthCacheModel(sequelize, DataTypes) {
  return sequelize.define(
    "AuthCache",
    {
      senderId: {
        type: DataTypes.STRING,
        primaryKey: true,
        field: "sender_id",
      },
      secret: {
        type: DataTypes.STRING,
        allowNull: false,
        field: "secret",
      },
      token: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: "token",
      },
      currentSessionId: {
        type: DataTypes.STRING,
        allowNull: true,
        field: "current_session_id",
      },
    },
    {
      tableName: "auth_cache",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  );
}
