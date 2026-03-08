export default function defineMessageDedupeModel(sequelize, DataTypes) {
  return sequelize.define(
    "MessageDedupe",
    {
      messageId: {
        type: DataTypes.STRING,
        primaryKey: true,
        field: "message_id",
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: "created_at",
      },
    },
    {
      tableName: "message_dedupe",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: false,
    },
  );
}
