const mongoose = require('mongoose');

const ManagersSchema = new mongoose.Schema({
    jam: { type: String, required: true },
    name: { type: String, required: true },
}, { collection: 'managers', versionKey: false });

const model = mongoose.model('ManagersModel', ManagersSchema);

module.exports = model;