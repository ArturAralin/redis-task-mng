"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const lib_1 = require("./src/lib");
const ioredis_1 = require("ioredis");
async function main() {
    const redis = new ioredis_1.Redis();
    const client = new lib_1.TaskTracker({
        redis,
    });
    await redis.ping();
    await client.waitReadiness();
    (0, lib_1.expressUiServer)({
        redis,
        client,
    }).listen(8817, () => {
        console.log('server started');
    });
}
main();
