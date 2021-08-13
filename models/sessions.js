const mongoose = require('mongoose');

const SessionsSchema = new mongoose.Schema({
    name: { type: String, required: true },
    token: { type: String, required: true },
    oneTimeToken: { type: String, required: false },
}, { collection: 'sessions', versionKey: false });

const model = mongoose.model('SessionsModel', SessionsSchema);

module.exports = model;