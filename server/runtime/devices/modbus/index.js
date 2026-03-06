/**
 * 'modbus': modbus wrapper to communicate with PLC throw RTU/TCP
 */

'use strict';
var ModbusRTU;
const datatypes = require('./datatypes');
const utils = require('../../utils');
const deviceUtils = require('../device-utils');
const net = require("net");
const TOKEN_LIMIT = 100;
const Mutex = require("async-mutex").Mutex;

function MODBUSclient(_data, _logger, _events, _runtime) {
    var memory = {};                        // Loaded Signal grouped by memory { memory index, start, size, ... }
    var data = JSON.parse(JSON.stringify(_data));                   // Current Device data { id, name, tags, enabled, ... }
    var logger = _logger;
    var client = new ModbusRTU();       // Client Modbus (Master)
    var working = false;                // Working flag to manage overloading polling and connection
    var events = _events;               // Events to commit change to runtime
    var lastStatus = '';                // Last Device status
    var varsValue = [];                 // Signale to send to frontend { id, type, value }
    var memItemsMap = {};               // Mapped Signale name with MemoryItem to find for set value
    var mixItemsMap = {};               // Map the fragmented Signale { key = start address, value = MemoryItems }
    var overloading = 0;                // Overloading counter to mange the break connection
    var lastTimestampValue;             // Last Timestamp of asked values
    var type;
    var runtime = _runtime;             // Access runtime config such as scripts
    
    // 失败设备管理
    var failedDevices = new Set(); // 存储失败的从站ID

    /**
     * initialize the modubus type
     */
    this.init = function (_type) {
        type = _type;
    }

    /**
     * Connect to PLC
     * Emit connection status to clients, clear all Tags values
     */
    this.connect = function () {
        return new Promise(function (resolve, reject) {
            if (data.property && data.property.address && (type === ModbusTypes.TCP ||
                (type === ModbusTypes.RTU && data.property.baudrate && data.property.databits && data.property.stopbits && data.property.parity))) {
                try {
                    if (!client.isOpen && _checkWorking(true)) {
                        logger.info(`'${data.name}' try to connect ${data.property.address}`, true);
                        
                        // 传统连接方式
                        _connect(function (err) {
                            if (err) {
                                logger.error(`'${data.name}' connect failed! ${err}`);
                                _emitStatus('connect-error');
                                _clearVarsValue();
                                reject();
                            } else {
                                if (data.property.slaveid) {
                                    // set the client's unit id
                                    client.setID(parseInt(data.property.slaveid));
                                }
                                // set a timout for requests default is null (no timeout)
                                client.setTimeout(2000);
                                logger.info(`'${data.name}' connected!`, true);
                                _emitStatus('connect-ok');
                                resolve();
                            }
                            _checkWorking(false);
                        });
                    } else {
                        reject();
                        _emitStatus('connect-error');
                    }
                } catch (err) {
                    logger.error(`'${data.name}' try to connect error! ${err}`);
                    _checkWorking(false);
                    _emitStatus('connect-error');
                    _clearVarsValue();
                    reject();
                }
            } else {
                logger.error(`'${data.name}' missing connection data!`);
                _emitStatus('connect-failed');
                _clearVarsValue();
                reject();
            }
        });
    }

    /**
     * Disconnect the PLC
     * Emit connection status to clients, clear all Tags values
     */
    this.disconnect = function () {
        return new Promise(function (resolve, reject) {
            _checkWorking(false);
            if (!client.isOpen) {
                _emitStatus('connect-off');
                _clearVarsValue();
                resolve(true);
            } else {
                client.close(function (result) {
                    if (result) {
                        logger.error(`'${data.name}' try to disconnect failed!`);
                    } else {
                        logger.info(`'${data.name}' disconnected!`, true);
                    }
                    _emitStatus('connect-off');
                    _clearVarsValue();
                    resolve(result);
                });
            }
        });
    }

    /**
     * Read values in polling mode
     * Update the tags values list, save in DAQ if value changed or in interval and emit values to clients
     */
    this.polling = async function () {
        let socketRelease;
        try {
            // Connexion/Resource reutilization logic (Socket/Serial) for TCP e RTU
            if (data.property.socketReuse) {
                let resourceKey;
                if (type === ModbusTypes.TCP) {
                    resourceKey = data.property.address;
                } else if (type === ModbusTypes.RTU) {
                    // Para RTU, usa o endereço da porta serial como identificador único do recurso
                    resourceKey = data.property.address;
                }

                if (resourceKey && runtime.socketMutex.has(resourceKey)) {
                    // Adquire o mutex para garantir acesso exclusivo ao recurso (socket TCP ou porta Serial RTU)
                    socketRelease = await runtime.socketMutex.get(resourceKey).acquire();
                }
            }

            await this._polling()
        } catch (err) {
            logger.error(`'${data.name}' polling! ${err}`);
        } finally {
            if (!utils.isNullOrUndefined(socketRelease)) {
                socketRelease()
            }
        }
    }
    this._polling = async function () {
        if (_checkWorking(true)) {
            var readVarsfnc = [];
            if (!data.property.options) {
                console.log('Polling memory:', Object.keys(memory));
                for (var memaddr in memory) {
                    // 解析内存地址中的站号前缀
                    const [slaveId, actualMemaddr] = memaddr.split(':');
                    console.log('Processing slave', slaveId, 'memaddr', actualMemaddr);
                    var tokenizedAddress = parseAddress(actualMemaddr);
                    try {
                        readVarsfnc.push(await _readMemory(parseInt(tokenizedAddress.address), memory[memaddr].Start, memory[memaddr].MaxSize, Object.values(memory[memaddr].Items)));
                        readVarsfnc.push(await delay(data.property.delay || 10));
                    } catch (err) {
                        logger.error(`'${data.name}' _readMemory error! ${err}`);
                    }
                }
            } else {
                console.log('Polling mixItemsMap:', Object.keys(mixItemsMap));
                for (var memaddr in mixItemsMap) {
                    try {
                        // 解析内存地址中的站号前缀
                        const [slaveId, actualMemaddr] = memaddr.split(':');
                        console.log('Processing slave', slaveId, 'memaddr', actualMemaddr);
                        readVarsfnc.push(await _readMemory(getMemoryAddress(parseInt(actualMemaddr), false), mixItemsMap[memaddr].Start, mixItemsMap[memaddr].MaxSize, Object.values(mixItemsMap[memaddr].Items)));
                        readVarsfnc.push(await delay(data.property.delay || 10));
                    } catch (err) {
                        logger.error(`'${data.name}' _readMemory error! ${err}`);
                    }
                }
            }
            // _checkWorking(false);
            try {
                const result = await Promise.all(readVarsfnc);

                _checkWorking(false);
                if (result.length) {
                    let varsValueChanged = await _updateVarsValue(result);
                    lastTimestampValue = new Date().getTime();
                    _emitValues(varsValue);
                    if (this.addDaq && !utils.isEmptyObject(varsValueChanged)) {
                        this.addDaq(varsValueChanged, data.name, data.id);
                    }
                } else {
                    // console.error('then error');
                }
                if (lastStatus !== 'connect-ok') {
                    _emitStatus('connect-ok');
                }
            } catch (reason) {
                if (reason) {
                    if (reason.stack) {
                        logger.error(`'${data.name}' _readVars error! ${reason.stack}`);
                    } else if (reason.message) {
                        logger.error(`'${data.name}' _readVars error! ${reason.message}`);
                    }
                } else {
                    logger.error(`'${data.name}' _readVars error! ${reason}`);
                }
                _checkWorking(false);
            };
        } else {
            _emitStatus('connect-busy');
        }
    }

    /**
     * Load Tags attribute to read with polling
     */
    this.load = function (_data) {
        data = JSON.parse(JSON.stringify(_data));
        memory = {};
        varsValue = [];
        memItemsMap = {};   // 清空旧的标签映射
        mixItemsMap = {};   // Map the fragmented tag { key = start address, value = MemoryItems }
        failedDevices.clear(); // 清空失败设备列表，重新开始
        var stepsMap = {};  // Map the tag start address and size { key = start address, value = signal size and offset }
        var count = 0;
        console.log('Loading tags:', Object.keys(_data.tags));
        for (var id in data.tags) {
            try {
                // 解析地址中的站号前缀
                const parsedAddress = parseAddressWithSlaveId(data.tags[id].address);
                console.log('Tag:', id, 'address:', data.tags[id].address, 'parsed:', parsedAddress);
                var offset = parseInt(parsedAddress.address) - 1;   // because settings address from 1 to 65536 but communication start from 0
                var token = Math.trunc(offset / TOKEN_LIMIT);
                // 在内存地址中添加站号前缀，确保不同从站的标签被分到不同的组
                var memaddr = parsedAddress.slaveId + ':' + formatAddress(data.tags[id].memaddress, token);
                console.log('Tag:', id, 'memaddr:', memaddr, 'offset:', offset);
                if (!memory[memaddr]) {
                    memory[memaddr] = new MemoryItems();
                }
                if (!memory[memaddr].Items[offset]) {
                    memory[memaddr].Items[offset] = new MemoryItem(data.tags[id].type, offset);
                }
                // 存储站号信息
                data.tags[id].slaveId = parsedAddress.slaveId;
                memory[memaddr].Items[offset].Tags.push(data.tags[id]); // because you can have multiple tags at the same DB address

                if (offset < memory[memaddr].Start) {
                    if (memory[memaddr].Start != 65536) {
                        memory[memaddr].MaxSize += memory[memaddr].Start - offset;
                        memory[memaddr].Start = offset;
                    } else {
                        memory[memaddr].MaxSize = datatypes[data.tags[id].type].WordLen;
                        memory[memaddr].Start = offset;
                    }
                } else {
                    var len = offset + datatypes[data.tags[id].type].WordLen - memory[memaddr].Start;
                    if (memory[memaddr].MaxSize < len) {
                        memory[memaddr].MaxSize = len;
                    }
                }
                memItemsMap[id] = memory[memaddr].Items[offset];
                memItemsMap[id].format = data.tags[id].format;
                stepsMap[parsedAddress.slaveId + ':' + (parseInt(data.tags[id].memaddress) + offset)] = { size: datatypes[data.tags[id].type].WordLen, offset: offset, slaveId: parsedAddress.slaveId, memaddr: memaddr };
                count++;
            } catch (err) {
                logger.error(`'${data.name}' load error! ${err}`);
            }
        }
        // for fragmented
        let lastStart = -1;             // last start address
        let lastMemAdr = -1;
        let nextAdr = -1;
        let lastSlaveId = -1;
        console.log('Processing stepsMap:', Object.keys(stepsMap));
        // 按从站 ID 和地址排序
        Object.keys(stepsMap).sort((a, b) => {
            const [slaveIdA, adrA] = a.split(':');
            const [slaveIdB, adrB] = b.split(':');
            if (parseInt(slaveIdA) !== parseInt(slaveIdB)) {
                return parseInt(slaveIdA) - parseInt(slaveIdB);
            }
            return parseInt(adrA) - parseInt(adrB);
        }).forEach(function (key) {
            try {
                // 解析键中的站号前缀
                const [slaveId, adrStr] = key.split(':');
                var adr = parseInt(adrStr);        // tag address
                let lastAdrSize = adr + stepsMap[key].size;
                let offset = stepsMap[key].offset;
                let memaddr = stepsMap[key].memaddr;
                console.log('Processing step:', key, 'slaveId:', slaveId, 'adr:', adr, 'lastAdrSize:', lastAdrSize, 'offset:', offset, 'memaddr:', memaddr);
                if (nextAdr <= adr || lastSlaveId !== slaveId) {
                    // to fragment then new range
                    lastStart = adr;
                    lastSlaveId = slaveId;
                    let mits = new MemoryItems();
                    mits.Start = lastStart - getMemoryAddress(lastStart, false);
                    mits.MaxSize = lastAdrSize - lastStart;
                    lastMemAdr = memaddr;
                    mits.Items = getMemoryItems(memory[lastMemAdr].Items, mits.Start, mits.MaxSize);
                    mixItemsMap[slaveId + ':' + lastStart] = mits;
                    console.log('Created new mixItem:', slaveId + ':' + lastStart, 'Start:', mits.Start, 'MaxSize:', mits.MaxSize);
                } else if (mixItemsMap[slaveId + ':' + lastStart]) {
                    // to attach of exist range
                    mixItemsMap[slaveId + ':' + lastStart].MaxSize = lastAdrSize - lastStart;
                    lastMemAdr = memaddr;
                    mixItemsMap[slaveId + ':' + lastStart].Items = getMemoryItems(memory[lastMemAdr].Items, mixItemsMap[slaveId + ':' + lastStart].Start, mixItemsMap[slaveId + ':' + lastStart].MaxSize);
                    console.log('Updated mixItem:', slaveId + ':' + lastStart, 'MaxSize:', mixItemsMap[slaveId + ':' + lastStart].MaxSize);
                }
                nextAdr = 1 + adr + stepsMap[key].size;
            } catch (err) {
                logger.error(`'${data.name}' load error! ${err}`);
            }
        });
        console.log('Loaded memory:', Object.keys(memory));
        console.log('Loaded mixItemsMap:', Object.keys(mixItemsMap));
        logger.info(`'${data.name}' data loaded (${count})`, true);
    }

    /**
     * Return Tags values array { id: <name>, value: <value>, type: <type> }
     */
    this.getValues = function () {
        return varsValue;
    }

    /**
     * Return Tag value { id: <name>, value: <value>, ts: <lastTimestampValue> }
     */
    this.getValue = function (id) {
        if (varsValue[id]) {
            return { id: id, value: varsValue[id].value, ts: lastTimestampValue };
        }
        return null;
    }

    /**
     * Return connection status 'connect-off', 'connect-ok', 'connect-error'
     */
    this.getStatus = function () {
        return lastStatus;
    }

    /**
     * Return Tag property
     */
    this.getTagProperty = function (id) {
        if (memItemsMap[id]) {
            return { id: id, name: id, type: memItemsMap[id].type, format: memItemsMap[id].format };
        } else {
            return null;
        }
    }

    /**
     * Set the Tag value
     * Read the current Tag object, write the value in object and send to SPS
     */
    this.setValue = async function (sigid, value) {
        if (data.tags[sigid]) {
            var memaddr = data.tags[sigid].memaddress;
            // 解析地址中的站号前缀
            const parsedAddress = parseAddressWithSlaveId(data.tags[sigid].address);
            var offset = parseInt(parsedAddress.address) - 1;   // because settings address from 1 to 65536 but communication start from 0
            var slaveId = parsedAddress.slaveId;
            value = await deviceUtils.tagRawCalculator(value, data.tags[sigid]);

            const divVal = convertValue(value, data.tags[sigid].divisor, true);
            var val;
            if (data.tags[sigid].scaleWriteFunction) {
                let parameters = [
                    { name: 'value', type: 'value', value: divVal }
                ];
                if (data.tags[sigid].scaleWriteParams) {
                    const extraParamsWithValues = JSON.parse(data.tags[sigid].scaleWriteParams);
                    parameters = [...parameters, ...extraParamsWithValues];

                }
                const script = {
                    id: data.tags[sigid].scaleWriteFunction,
                    name: null,
                    parameters
                };
                try {
                    const bufVal = await runtime.scriptsMgr.runScript(script, false);
                    if (Array.isArray(bufVal)) {
                        if ((bufVal.length % 2) !== 0) {
                            logger.error(`'${data.tags[sigid].name}' setValue script error, returned buffer invalid must be mod 2`);
                            return false;
                        }
                        val = [];
                        for (let i = 0; i < bufVal.length;) {
                            val.push(bufVal.readUInt16BE(i));
                            i = i + 2;
                        }
                    } else {
                        val = bufVal;
                    }
                } catch (error) {
                    logger.error(`'${data.tags[sigid].name}' setValue script error! ${error.toString()}`);
                    return false;
                }

            } else {
                val = datatypes[data.tags[sigid].type].formatter(divVal);
            }

            // Wait logic for RTU removed, o Mutex will control concurrency.
            // if (type === ModbusTypes.RTU) {
            //     const start = Date.now();
            //     let now = start;
            //     while ((now - start) < 3000 && working) {  // wait max 3 seconds
            //         now = Date.now();
            //         await delay(20);
            //     }
            // }

            let socketRelease;
            try {
                // Connexion/Resource reutilization logic (Socket/Serial) for TCP and RTU
                if (data.property.socketReuse) {
                    let resourceKey;
                    if (type === ModbusTypes.TCP || type === ModbusTypes.RTU) {
                        // For TCP: socket addres. For RTU: serial port address
                        resourceKey = data.property.address;
                    }

                    if (resourceKey && runtime.socketMutex.has(resourceKey)) {
                        socketRelease = await runtime.socketMutex.get(resourceKey).acquire();
                    }
                }

                _checkWorking(true);

                await _writeMemory(parseInt(memaddr), offset, val, slaveId).then(result => {
                    logger.info(`'${data.name}' setValue(${sigid}, ${value}) to slave ${slaveId}`, true, true);
                }, reason => {
                    if (reason && reason.stack) {
                        logger.error(`'${data.name}' _writeMemory error! ${reason.stack}`);
                    } else {
                        logger.error(`'${data.name}' _writeMemory error! ${reason}`);
                    }
                    // 标记设备为失败
                    failedDevices.add(parseInt(slaveId));
                });
            } catch (err) {
                logger.error(`'${data.name}' setValue error! ${err}`);
                // 标记设备为失败
                failedDevices.add(parseInt(slaveId));
            } finally {
                _checkWorking(false);
                if (!utils.isNullOrUndefined(socketRelease)) {
                    socketRelease();
                }
            }
            return true;
        } else {
            logger.error(`'${data.name}' setValue(${sigid}, ${value}) Tag not found`, true, true);
        }
        return false;
    }

    /**
     * Return if PLC is connected
     * Don't work if PLC will disconnect
     */
    this.isConnected = function () {
        return client.isOpen;
    }

    /**
     * Bind the DAQ store function
     */
    this.bindAddDaq = function (fnc) {
        this.addDaq = fnc;                         // Add the DAQ value to db history
    }

    this.addDaq = null;

    /**
     * Return the timestamp of last read tag operation on polling
     * @returns
     */
    this.lastReadTimestamp = () => {
        return lastTimestampValue;
    }

    /**
     * Return the Daq settings of Tag
     * @returns
     */
    this.getTagDaqSettings = (tagId) => {
        return data.tags[tagId] ? data.tags[tagId].daq : null;
    }

    /**
     * Set Daq settings of Tag
     * @returns
     */
    this.setTagDaqSettings = (tagId, settings) => {
        if (data.tags[tagId]) {
            utils.mergeObjectsValues(data.tags[tagId].daq, settings);
        }
    }

    /**
     * Connect with RTU or TCP
     */
    /**
     * 解析地址中的站号前缀，支持 "S=2;1" 或 "3.5" 格式
     * @param {*} address - 地址（字符串或数字）
     * @returns {object} 包含站号和实际地址的对象
     */
    var parseAddressWithSlaveId = function (address) {
        // 确保 address 是字符串
        const addressStr = String(address);
        
        // 支持 "S=2;1" 格式
        const slaveIdPattern = /^S=(\d+);(.*)$/;
        const match = addressStr.match(slaveIdPattern);
        if (match) {
            return {
                slaveId: parseInt(match[1]),
                address: match[2]
            };
        }
        
        // 支持 "3.5" 格式（从站3，地址5）
        const dotPattern = /^(\d+)\.(\d+)$/;
        const dotMatch = addressStr.match(dotPattern);
        if (dotMatch) {
            return {
                slaveId: parseInt(dotMatch[1]),
                address: dotMatch[2]
            };
        }
        
        // 默认格式
        return {
            slaveId: data.property.slaveid ? parseInt(data.property.slaveid) : 1, // 默认从站为1
            address: addressStr
        };
    }

    var _connect = function (callback) {
        try {
            if (type === ModbusTypes.RTU) {
                const rtuOptions = {
                    baudRate: parseInt(data.property.baudrate),
                    dataBits: parseInt(data.property.databits),
                    stopBits: parseFloat(data.property.stopbits),
                    parity: data.property.parity.toLowerCase()
                }

                // >>> ADDED: Initialize the mutex for  Modbus RTU (porta serial) <<<
                if (data.property.socketReuse === ModbusReuseModeType.ReuseSerial && !runtime.socketMutex.has(data.property.address)) {
                    // port address (data.property.address) is the key for the resource
                    runtime.socketMutex.set(data.property.address, new Mutex());
                }
                // >>> END OF CHANGE <<<

                if (data.property.connectionOption === ModbusOptionType.RTUBufferedPort) {
                    client.connectRTUBuffered(data.property.address, rtuOptions, callback);
                } else if (data.property.connectionOption === ModbusOptionType.AsciiPort) {
                    client.connectAsciiSerial(data.property.address, rtuOptions, callback);
                } else {
                    client.connectRTU(data.property.address, rtuOptions, callback);
                }
            } else if (type === ModbusTypes.TCP) {
                var port = 502;
                var addr = data.property.address;
                if (data.property.address.indexOf(':') !== -1) {
                    addr = data.property.address.substring(0, data.property.address.indexOf(':'));
                    var temp = data.property.address.substring(data.property.address.indexOf(':') + 1);
                    port = parseInt(temp);
                }
                //reuse socket
                if (data.property.socketReuse) {
                    var socket;
                    if (runtime.socketPool.has(data.property.address)) {
                        socket = runtime.socketPool.get(data.property.address);
                    } else {
                        socket = new net.Socket();
                        runtime.socketPool.set(data.property.address, socket);
                        //init read mutex
                        if (data.property.socketReuse === ModbusReuseModeType.ReuseSerial) {
                            runtime.socketMutex.set(data.property.address, new Mutex())
                        }
                    }
                    var openFlag = socket.readyState === "opening" || socket.readyState === "open";
                    if (!openFlag) {
                        socket.connect({
                            // Default options
                            ...{
                                host: addr,
                                port: port
                            },
                        });
                    }
                }
                if (data.property.connectionOption === ModbusOptionType.UdpPort) {
                    client.connectUDP(addr, { port: port }, callback);
                } else if (data.property.connectionOption === ModbusOptionType.TcpRTUBufferedPort) {
                    if (data.property.socketReuse) {
                        client.linkTcpRTUBuffered(runtime.socketPool.get(data.property.address), callback);
                    } else {
                        client.connectTcpRTUBuffered(addr, { port: port }, callback);
                    }
                } else if (data.property.connectionOption === ModbusOptionType.TelnetPort) {
                    if (data.property.socketReuse) {
                        client.linkTelnet(runtime.socketPool.get(data.property.address), callback);
                    } else {
                        client.connectTelnet(addr, { port: port }, callback);
                    }
                } else {
                    //reuse socket
                    if (data.property.socketReuse) {
                        client.linkTCP(runtime.socketPool.get(data.property.address), callback);
                    } else {
                        client.connectTCP(addr, { port: port }, callback);
                    }
                }
            }
        } catch (err) {
            callback(err);
        }
    }

    /**
     * Read a Memory from modbus and parse the result
     * @param {int} memoryAddress - The memory address to read
     * @param {int} start - Position of the first variable
     * @param {int} size - Length of the variables to read (the last address)
     * @param {array} vars - Array of Var objects
     * @returns {Promise} - Resolves to the vars array with populate *value* property
     */
    var _readMemory = async function (memoryAddress, start, size, vars) {
        if (vars.length === 0) return [];
        
        // 输出关键信息，减少日志量
            if (logger && logger.debug) {
                logger.debug(`'${data.name}' Reading memory: ${memoryAddress}, start: ${start}, size: ${size}, slave: ${vars[0]?.Tags[0]?.slaveId || 'unknown'}`);
            }
        
            // 获取所有标签的从站ID，确保它们都相同
            const slaveIds = new Set();
            vars.forEach(v => {
                v.Tags.forEach(tag => {
                    slaveIds.add(tag.slaveId || 1);
                });
            });
        
            // 确保所有标签都属于同一个从站
            if (slaveIds.size !== 1) {
                if (logger && logger.error) {
                    logger.error(`'${data.name}' All tags in a single read operation must belong to the same slave ID`);
                }
                return vars;
            }
        
            const slaveId = Array.from(slaveIds)[0];
        
            // 检查设备是否失败
            if (failedDevices.has(slaveId)) {
                if (logger && logger.debug) {
                    logger.debug(`'${data.name}' Skipping failed device: slave ${slaveId}`);
                }
                // 标记为未改变
                vars.forEach(v => {
                    v.changed = false;
                });
                return vars;
            }
        
            try {
                // 等待一小段时间，确保前一个操作完成
                await new Promise(resolve => setTimeout(resolve, 100));
            
                // 设置从站 ID
                client.setID(slaveId);
            
                // 等待从站ID设置生效
                await new Promise(resolve => setTimeout(resolve, 50));

                // 执行读取操作
                let res;
                if (memoryAddress === ModbusMemoryAddress.CoilStatus) {
                    res = await client.readCoils(start, size);
                } else if (memoryAddress === ModbusMemoryAddress.DigitalInputs) {
                    res = await client.readDiscreteInputs(start, size);
                } else if (memoryAddress === ModbusMemoryAddress.InputRegisters) {
                    res = await client.readInputRegisters(start, size);
                } else if (memoryAddress === ModbusMemoryAddress.HoldingRegisters) {
                    res = await client.readHoldingRegisters(start, size);
                } else {
                    return vars;
                }

                // 处理读取结果
                // modbus-serial 返回的数据在 res.data 中（数组格式）
                let buffer;
                if (res.buffer) {
                    buffer = res.buffer;
                } else if (res.data && res.data.buffer) {
                    // res.data 是 Uint16Array，res.data.buffer 是 ArrayBuffer
                    buffer = Buffer.from(res.data.buffer);
                } else if (res.data) {
                    // 直接从数组创建 Buffer
                    buffer = Buffer.alloc(res.data.length * 2);
                    for (let i = 0; i < res.data.length; i++) {
                        buffer.writeUInt16BE(res.data[i], i * 2);
                    }
                }
            
                if (buffer) {
                    // 标记设备为正常
                    failedDevices.delete(slaveId);
                
                    vars.forEach(v => {
                        try {
                            if (memoryAddress === ModbusMemoryAddress.CoilStatus || memoryAddress === ModbusMemoryAddress.DigitalInputs) {
                                // 对于 Coil 和 Digital Inputs，res.data 是布尔值数组
                                if (res.data && Array.isArray(res.data) && typeof res.data[0] === 'boolean') {
                                    let bitIndex = v.offset - start;
                                    // 添加边界检查
                                    let value = false;
                                    if (bitIndex >= 0 && bitIndex < res.data.length) {
                                        value = res.data[bitIndex] || false;
                                    }
                                    v.changed = value !== v.rawValue;
                                    v.rawValue = value;
                                } else {
                                    // 兼容旧版本的 buffer 格式
                                    let bitoffset = Math.trunc((v.offset - start) / 8);
                                    let bit = (v.offset - start) % 8;
                                    let value = datatypes[v.type].parser(buffer, bitoffset, bit);
                                    v.changed = value !== v.rawValue;
                                    v.rawValue = value;
                                }
                            } else {
                                let byteoffset = (v.offset - start) * 2;
                                let dataBuffer = Buffer.from(buffer.slice(byteoffset, byteoffset + datatypes[v.type].bytes));
                                let value = datatypes[v.type].parser(dataBuffer);
                                v.changed = value !== v.rawValue;
                                v.rawValue = value;
                            }
                        } catch (err) {
                            if (logger && logger.error) {
                                logger.error(`'${data.name}' Error parsing tag value: ${err}, tag: ${v.Tags && v.Tags.length > 0 ? v.Tags[0].id : 'NO TAGS'}`);
                            }
                        }
                    });
                } else {
                    if (logger && logger.error) {
                        logger.error(`'${data.name}' No data received from slave ${slaveId}`);
                    }
                }
            } catch (err) {
                if (logger && logger.error) {
                    logger.error(`'${data.name}' Error reading from slave ${slaveId}: ${err}`);
                }
                // 标记设备为失败
                failedDevices.add(slaveId);
                // 标记为未改变
                vars.forEach(v => {
                    v.changed = false;
                });
            }
        
        return vars;
    }

    /**
     * Write value to modbus
     * @param {*} memoryAddress
     * @param {*} start
     * @param {*} value
     * @param {*} slaveId - 从站ID
     */
    var _writeMemory = function (memoryAddress, start, value, slaveId = 1) {
        return new Promise((resolve, reject) => {
            try {
                // 检查设备是否失败
                if (failedDevices.has(parseInt(slaveId))) {
                    console.log(`Skipping failed device: slave ${slaveId} on port ${data.property.address}`);
                    reject(new Error(`Device slave ${slaveId} is marked as failed`));
                    return;
                }
                
                // 设置从站 ID
                client.setID(slaveId);

                if (memoryAddress === ModbusMemoryAddress.CoilStatus) {                      // Coil Status (Read/Write 000001-065536)
                    client.writeCoil(start, value).then(res => {
                        // 写入成功，标记设备为正常
                        failedDevices.delete(parseInt(slaveId));
                        resolve();
                    }, reason => {
                        console.error(`Error writing to slave ${slaveId}:`, reason);
                        // 标记设备为失败
                        failedDevices.add(parseInt(slaveId));
                        reject(reason);
                    });
                } else if (memoryAddress === ModbusMemoryAddress.DigitalInputs) {           // Digital Inputs (Read 100001-165536)
                    reject();
                } else if (memoryAddress === ModbusMemoryAddress.InputRegisters) {          // Input Registers (Read  300001-365536)
                    reject();
                } else if (memoryAddress === ModbusMemoryAddress.HoldingRegisters) {
                    // Utiliser forceFC16 depuis la config du device
                    if (value.length > 2 || data.property.forceFC16) {
                        client.writeRegisters(start, value).then(res => {
                            // 写入成功，标记设备为正常
                            failedDevices.delete(parseInt(slaveId));
                            resolve();
                        }, reason => {
                            console.error(`Error writing to slave ${slaveId}:`, reason);
                            // 标记设备为失败
                            failedDevices.add(parseInt(slaveId));
                            reject(reason);
                        });
                    } else {
                        client.writeRegister(start, value).then(res => {
                            // 写入成功，标记设备为正常
                            failedDevices.delete(parseInt(slaveId));
                            resolve();
                        }, reason => {
                            console.error(`Error writing to slave ${slaveId}:`, reason);
                            // 标记设备为失败
                            failedDevices.add(parseInt(slaveId));
                            reject(reason);
                        });
                    }
                } else {
                    reject();
                }
            } catch (err) {
                console.error(`Error writing to slave ${slaveId}:`, err);
                // 标记设备为失败
                failedDevices.add(parseInt(slaveId));
                reject(err);
            }
        });
    }

    /**
     * Clear the Tags values by setting to null
     * Emit to clients
     */
    var _clearVarsValue = function () {
        for (var id in varsValue) {
            varsValue[id].value = null;
        }
        for (var id in memItemsMap) {
            memItemsMap[id].value = null;
        }
        _emitValues(varsValue);
    }

    /**
     * Update the Tags values read
     * @param {*} vars
     */
    var _updateVarsValue = async (vars) => {
        var someval = false;
        var tempTags = {};
        for (var vid in vars) {
            let items = vars[vid];
            for (var itemidx in items) {
                const changed = items[itemidx].changed;
                if (items[itemidx] instanceof MemoryItem) {
                    let type = items[itemidx].type;
                    let rawValue = items[itemidx].rawValue;
                    let tags = items[itemidx].Tags;
                    tags.forEach(tag => {
                        tempTags[tag.id] = {
                            id: tag.id,
                            rawValue: convertValue(rawValue, tag.divisor),
                            type: type,
                            daq: tag.daq,
                            changed: changed,
                            tagref: tag
                        };
                        someval = true;
                    });
                } else {
                    tempTags[items[itemidx].id] = {
                        id: items[itemidx].id,
                        rawValue: items[itemidx].rawValue,
                        type: items[itemidx].type,
                        daq: items[itemidx].daq,
                        changed: changed,
                        tagref: items[itemidx]
                    };
                    someval = true;
                }
            }
        }
        if (someval) {
            const timestamp = new Date().getTime();
            var result = {};
            for (var id in tempTags) {
                // 如果 rawValue 为 null，直接将 value 设置为 null
                if (utils.isNullOrUndefined(tempTags[id].rawValue)) {
                    tempTags[id].value = null;
                    if (logger && logger.debug) {
                        logger.debug(`'${data.name}' Tag ${id}: rawValue is null, setting value to null`);
                    }
                } else {
                    // 否则计算 value
                    tempTags[id].value = await deviceUtils.tagValueCompose(tempTags[id].rawValue, varsValue[id] ? varsValue[id].value : null, tempTags[id].tagref, runtime);
                    if (logger && logger.debug) {
                        logger.debug(`'${data.name}' Tag ${id}: rawValue=${tempTags[id].rawValue}, value=${tempTags[id].value}`);
                    }
                }
                tempTags[id].timestamp = timestamp;
                // 只有 rawValue 不为 null 时才保存到 DAQ
                if (!utils.isNullOrUndefined(tempTags[id].rawValue) && this.addDaq && deviceUtils.tagDaqToSave(tempTags[id], timestamp)) {
                    result[id] = tempTags[id];
                }
                varsValue[id] = tempTags[id];
                varsValue[id].changed = false;
            }
            return result;
        }
        return null;
    }

    /**
     * Emit the PLC Tags values array { id: <name>, value: <value>, type: <type> }
     * @param {*} values
     */
    var _emitValues = function (values) {
        events.emit('device-value:changed', { id: data.id, values: values });
    }

    /**
     * Emit the PLC connection status
     * @param {*} status
     */
    var _emitStatus = function (status) {
        lastStatus = status;
        events.emit('device-status:changed', { id: data.id, status: status });
    }

    /**
     * Used to manage the async connection and polling automation (that not overloading)
     * @param {*} check
     */
    var _checkWorking = function (check) {
        if (check && working) {
            overloading++;
            // !The driver don't give the break connection
            if (overloading >= 3) {
                if (type !== ModbusTypes.RTU) {
                    logger.warn(`'${data.name}' working (connection || polling) overload! ${overloading}`);
                }
                client.close();
            } else {
                return false;
            }
        }
        working = check;
        overloading = 0;
        return true;
    }

    const formatAddress = function (address, token) { return token + '-' + address; }
    const parseAddress = function (address) { return { token: address.split('-')[0], address: address.split('-')[1] }; }
    const getMemoryAddress = function (address, askey, token) {
        if (address < ModbusMemoryAddress.DigitalInputs) {
            if (askey) {
                return formatAddress('000000', token);
            }
            return ModbusMemoryAddress.CoilStatus;
        } else if (address < ModbusMemoryAddress.InputRegisters) {
            if (askey) {
                return formatAddress(ModbusMemoryAddress.DigitalInputs, token);
            }
            return ModbusMemoryAddress.DigitalInputs;
        } else if (address < ModbusMemoryAddress.HoldingRegisters) {
            if (askey) {
                return formatAddress(ModbusMemoryAddress.InputRegisters, token);
            }
            return ModbusMemoryAddress.InputRegisters;
        } else {
            if (askey) {
                return formatAddress(ModbusMemoryAddress.HoldingRegisters, token);
            }
            return ModbusMemoryAddress.HoldingRegisters;
        }
    }
    const convertValue = function (value, divisor, tosrc = false) {
        try {
            if (divisor && parseFloat(divisor)) {
                if (tosrc) {
                    return value * parseFloat(divisor);
                } else {
                    return value / parseFloat(divisor);
                }
            }
        } catch (err) {
            console.error(err);
        }
        return value;
    }

    /**
     * Return the Items that are wit address and size in the range start, size
     * @param {*} items
     * @param {*} start
     * @param {*} size
     * @returns
     */
    const getMemoryItems = function (items, start, size) {
        let result = {};
        for (var itemidx in items) {
            if (items[itemidx].offset >= start && items[itemidx].offset < start + size) {
                result[itemidx] = items[itemidx];
            }
        }
        return result;
    }
    const delay = ms => { return new Promise(resolve => setTimeout(resolve, ms)) };
}

const ModbusTypes = { RTU: 0, TCP: 1 };
const ModbusMemoryAddress = { CoilStatus: 0, DigitalInputs: 100000, InputRegisters: 300000, HoldingRegisters: 400000 };
const ModbusOptionType = {
    SerialPort: 'SerialPort',
    RTUBufferedPort: 'RTUBufferedPort',
    AsciiPort: 'AsciiPort',
    TcpPort: 'TcpPort',
    UdpPort: 'UdpPort',
    TcpRTUBufferedPort: 'TcpRTUBufferedPort',
    TelnetPort: 'TelnetPort'
}
const ModbusReuseModeType = {
    Reuse: 'Reuse',
    ReuseSerial: 'ReuseSerial',
}

module.exports = {
    init: function (settings) {
        // deviceCloseTimeout = settings.deviceCloseTimeout || 15000;
    },
    create: function (data, logger, events, manager, runtime) {
        try { ModbusRTU = require('modbus-serial'); } catch { }
        if (!ModbusRTU && manager) { try { ModbusRTU = manager.require('modbus-serial'); } catch { } }
        if (!ModbusRTU) return null;
        return new MODBUSclient(data, logger, events, runtime);
    },
    ModbusTypes: ModbusTypes
}

function MemoryItem(type, offset) {
    this.offset = offset;
    this.type = type;
    this.bit = -1;
    this.Tags = [];
    this.rawValue = null;  // 初始化 rawValue
    this.changed = false;  // 初始化 changed 标志
}

function MemoryItems() {
    this.Start = 65536;
    this.MaxSize = 0;
    this.Items = {};
}
