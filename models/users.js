const mongoose = require('mongoose');

const UsersSchema = new mongoose.Schema({
    name: { type: String, required: true },
    admin: { type: Boolean, required: false },
    banned: { type: Boolean, required: false },
    meta: {
        updated: { type: Date, required: false },
        updatedBy: { type: String, required: false }
    }
}, { collection: 'users', versionKey: false });

UsersSchema.index('name', { unique: true });

const model = mongoose.model('UsersModel', UsersSchema);

module.exports = model;