# FUXA Modbus RTU 多从设备支持

[English](./README.md) | [中文](./README.zh-CN.md)

Modbus RTU 多从设备驱动程序，为 FUXA 提供对多个 Modbus RTU 从站设备共享单一 COM 端口的支持。

## 功能特性

- **多从站支持**：多个 Modbus RTU 从站共享单一 COM 端口
- **灵活的地址格式**：支持 `S=x;y` 和 `x.y` 两种地址格式
- **数据隔离**：使用 `slaveId:memoryAddress` 格式实现不同从站的数据隔离
- **并发控制**：使用 Mutex 实现串口共享和并发访问
- **失败恢复**：自动检测并恢复失败的从站设备
- **支持的数据类型**：
  - Int16 / UInt16
  - Int32 / UInt32
  - Int64 / UInt64
  - Float32
  - Float64
  - Bool (Coil/Input)
  - 字节序支持：BE (大端序)、LE (小端序)、MLE (Modbus 中间小端序)

## 安装

1. 克隆此仓库或复制以下文件到你的 FUXA 项目中：
   - `server/runtime/devices/modbus/index.js`
   - `server/runtime/devices/device-utils.js`

2. 重启 FUXA 服务

## 配置说明

### 地址格式

在 FUXA 设备配置中，使用以下格式指定从站地址：

**格式1：点分隔符（推荐）**
```
从站ID.寄存器地址
例如：1.1 表示从站1，地址1
```

**格式2：分号分隔符**
```
S=从站ID;寄存器地址
例如：S=1;1 表示从站1，地址1
```

### 寄存器类型

| 类型 | 地址范围 | 说明 |
|------|----------|------|
| Coil Status | 000001-065536 | 读写线圈 |
| Digital Inputs | 100001-165536 | 只读离散输入 |
| Input Registers | 300001-365536 | 只读输入寄存器 |
| Holding Registers | 400001-465536 | 读写保持寄存器 |

### 数据类型

在变量配置中选择适当的数据类型：

| 类型 | 字节数 | 说明 |
|------|--------|------|
| Int16 | 2 | 16位有符号整数 |
| UInt16 | 2 | 16位无符号整数 |
| Int32 | 4 | 32位有符号整数 |
| UInt32 | 4 | 32位无符号整数 |
| Int64 | 8 | 64位有符号整数 |
| Float32 | 4 | 32位浮点数 |
| Float64 | 8 | 64位浮点数 |
| Bool | 1 | 布尔值 |
| Int32-LE | 4 | 32位有符号整数（小端序） |
| Int32-MLE | 4 | 32位有符号整数（Modbus中间小端序） |
| Float32-LE | 4 | 32位浮点数（小端序） |
| Float64-LE | 8 | 64位浮点数（小端序） |

## 使用示例

### 示例1：单从站配置

```
设备名称：ModbusRTU1
通讯方式：RTU Serial
COM端口：COM20
从站ID：1
```

变量配置：
| 名称 | 地址 | 类型 |
|------|------|------|
| H1 | 1 | Int16 |
| H2 | 2 | Int16 |

### 示例2：多从站配置

```
设备名称：ModbusRTU1
通讯方式：RTU Serial
COM端口：COM20
从站ID：1（默认）
```

变量配置：
| 名称 | 地址 | 类型 |
|------|------|------|
| H1_Slave1 | 1.1 | Int16 |
| H1_Slave2 | 2.1 | Int16 |
| H1_Slave3 | 3.1 | Int16 |
| Coil_Slave1 | 1.1 | Bool |
| Input_Slave1 | 100001 | Bool |

## 导入测试配置

项目中包含了 `fuxa-devices.json` 文件，可用于导入测试配置：

1. 在 FUXA 界面中进入"设置" -> "项目"
2. 点击"导入项目"按钮
3. 选择 `fuxa-devices.json` 文件
4. 导入后即可看到预配置的测试变量

## 测试报告

详细测试结果请参阅 [MODBUS_RTU_TEST_REPORT.md](./MODBUS_RTU_TEST_REPORT.md)

### 测试摘要

| 测试项目 | 状态 |
|---------|------|
| Coil Status | ✅ 通过 |
| Digital Inputs | ✅ 通过 |
| Input Registers | ✅ 通过 |
| Holding Registers | ✅ 通过 |
| Float64 | ✅ 通过 |

## 故障排除

### 问题：添加/删除变量后数据变为空

**原因**：失败设备列表未被正确清除

**解决方案**：更新到最新版本（已在 load 函数中添加 `failedDevices.clear()`）

### 问题：Coil/Input 类型变量显示为空

**原因**：布尔值被错误转换为数字

**解决方案**：在 `device-utils.js` 中修改 `tagValueCompose` 函数，排除 Bool/Boolean 类型

### 问题：Float64 类型显示异常

**原因**：Buffer 创建逻辑错误

**解决方案**：更新代码以正确处理 Buffer 创建

### 问题：串口被占用

**解决**：关闭占用串口的应用程序，或使用 `taskkill /F /IM node.exe` 终止冲突进程

## 技术细节

### 内存地址分组

使用 `slaveId:memoryAddress` 格式实现数据隔离：
- `1:400000` - 从站1的保持寄存器
- `2:400000` - 从站2的保持寄存器
- 依此类推

### 并发控制

使用 Mutex 实现串口访问的并发控制，确保同一时间只有一个操作访问串口。

### 失败恢复机制

- 当从站读取失败时，将其标记为失败设备
- 在后续轮询中跳过失败设备
- 成功读取后自动清除失败标记

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
