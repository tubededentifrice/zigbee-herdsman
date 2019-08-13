import events from 'events';
import Database from './database';
import {TsType as AdapterTsType, ZStackAdapter, Adapter} from '../adapter';
import {Entity, Device} from './model';
import {Events as AdapterEvents, DeviceJoinedPayload, ZclDataPayload, DeviceAnnouncePayload as AdapterDeviceAnnouncePayload} from '../adapter/events'
import {ZclFrameConverter} from './helpers';
import {FrameType, Foundation} from '../zcl';
import {Events, MessagePayload, MessagePayloadType, CommandsLookup, DeviceInterviewPayload, DeviceAnnouncePayload} from './events';
import {KeyValue} from './tstype';

// @ts-ignore
import mixin from 'mixin-deep';
import Group from './model/group';

interface Options {
    network: AdapterTsType.NetworkOptions;
    serialPort: AdapterTsType.SerialPortOptions;
    databasePath: string;
    backupPath: string;
};

const DefaultOptions: Options = {
    network: {
        networkKeyDistribute: false,
        networkKey: [0x01, 0x03, 0x05, 0x07, 0x09, 0x0B, 0x0D, 0x0F, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0A, 0x0C, 0x0D],
        panID: 0x1a62,
        extenedPanID: [0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD],
        channelList: [11],
    },
    serialPort: {
        baudRate: 115200,
        rtscts: true,
        path: null,
    },
    databasePath: null,
    backupPath: null,
}

const debug = {
    error: require('debug')('zigbee-herdsman:controller:error'),
    log: require('debug')('zigbee-herdsman:controller:log'),
};

class Controller extends events.EventEmitter {
    private options: Options;
    private database: Database;
    private adapter: Adapter;
    // eslint-disable-next-line
    private permitJoinTimer: any;

    public constructor(options: Options) {
        super();
        this.options = mixin(DefaultOptions, options);
        this.adapter = new ZStackAdapter(options.network, options.serialPort, options.backupPath);

        this.onDeviceJoined = this.onDeviceJoined.bind(this);
        this.adapter.on(AdapterEvents.deviceJoined, this.onDeviceJoined);
        this.onZclData = this.onZclData.bind(this);
        this.adapter.on(AdapterEvents.zclData, this.onZclData);
        this.onAdapterDisconnected = this.onAdapterDisconnected.bind(this);
        this.adapter.on(AdapterEvents.disconnected, this.onAdapterDisconnected);
        this.onDeviceAnnounce = this.onDeviceAnnounce.bind(this);
        this.adapter.on(AdapterEvents.deviceAnnounce, this.onDeviceAnnounce);
    }

    public async start(): Promise<void> {
        debug.log(`Starting with options '${JSON.stringify(this.options)}'`);
        this.database = await Database.open(this.options.databasePath);
        await this.adapter.start();

        // Inject adapter and database in entity
        Entity.injectAdapter(this.adapter);
        Entity.injectDatabse(this.database);

        // Add coordinator to the database if it is not there yet.
        if ((await Device.findByType('Coordinator')).length === 0) {
            debug.log('No coordinator in database, querying...');
            const coordinator = await this.adapter.getCoordinator();
            Device.create(
                'Coordinator', coordinator.ieeeAddr, coordinator.networkAddress, coordinator.manufacturerID,
                undefined, undefined, undefined, coordinator.endpoints
            );
        }

        setTimeout(async (): Promise<void> => {
            const device = await Device.findByIeeeAddr('0x000b57fffec6a5b2');
            const endpoint = device.getEndpoint(1);
            const group = await this.getOrCreateGroup(1);
            //group.addEndpoint(endpoint);
            //await group.addEndpoint(endpoint);
            //console.log('send on');
            group.command('genOnOff', 'off', {});
            //endpoint.bind('genOnOff', coordinator.getEndpoint(1));
        }, 1000);
    }

    public async permitJoin(permit: boolean): Promise<void> {
        if (permit && !this.permitJoinTimer) {
            debug.log('Permit joining')
            await this.adapter.permitJoin(254);

            // Zigbee 3 networks automatically close after max 255 seconds, keep network open.
            this.permitJoinTimer = setInterval(async (): Promise<void> => {
                debug.log('Permit joining')
                await this.adapter.permitJoin(254);
            }, 200 * 1000);
        } else if (permit && this.permitJoinTimer) {
            debug.log('Joining already permitted')
        } else {
            debug.log('Disable joining');
            this.adapter.permitJoin(0);

            if (this.permitJoinTimer) {
                clearInterval(this.permitJoinTimer);
                this.permitJoinTimer = null;
            }
        }
    }

    public getPermitJoin(): boolean {
        return this.permitJoin != null;
    }

    public async stop(): Promise<void> {
        await this.permitJoin(false);
        await this.adapter.stop();
    }

    public async softReset(): Promise<void> {
        await this.adapter.softReset();
    }

    public async getCoordinatorVersion(): Promise<AdapterTsType.CoordinatorVersion> {
        return await this.adapter.getCoordinatorVersion();
    }

    public async getDevices(): Promise<Device[]> {
        return Device.all();
    }

    public async getDevice(ieeeAddr: string): Promise<Device> {
        return Device.findByIeeeAddr(ieeeAddr);
    }

    public async getOrCreateGroup(groupID: number): Promise<Group> {
        return await Group.findByGroupID(groupID) || await Group.create(groupID);
    }

    public async disableLED(): Promise<void> {
        await this.adapter.disableLED();
    }

    private async onDeviceAnnounce(payload: AdapterDeviceAnnouncePayload): Promise<void> {
        debug.log(`Device announce '${payload.ieeeAddr}'`);
        const data: DeviceAnnouncePayload = {device: await Device.findByIeeeAddr(payload.ieeeAddr)};
        this.emit(Events.deviceAnnounce, data);
    }

    private async onAdapterDisconnected(): Promise<void> {
        debug.log(`Adapter disconnected'`);

        try {
            await this.adapter.stop();
        } catch (error) {
        }

        this.emit(Events.adapterDisconnected);
    }

    private async onDeviceJoined(payload: DeviceJoinedPayload): Promise<void> {
        let device = await Device.findByIeeeAddr(payload.ieeeAddr)
        if (!device) {
            debug.log(`New device '${payload.ieeeAddr}' joined`);
            debug.log(`Creating device '${payload.ieeeAddr}'`);
            device = await Device.create(
                undefined, payload.ieeeAddr, payload.networkAddress, undefined,
                undefined, undefined, undefined, []
            );

            this.emit(Events.deviceJoined, device);
        } else if (device.get('networkAddress') !== payload.networkAddress) {
            debug.log(`Device '${payload.ieeeAddr}' is already in database with different networkAddress, updating networkAddress`);
            await device.set('networkAddress', payload.networkAddress);
        }

        if (!device.get('interviewed')) {
            const payloadStart: DeviceInterviewPayload = {status: 'started', device};
            debug.log(`Interview '${device.get('ieeeAddr')}' start`);
            this.emit(Events.deviceInterview, payloadStart);

            const status = await device.interview();
            if (status !== 'alreadyInProgress') {
                const payloadDone: DeviceInterviewPayload = {status, device};
                this.emit(Events.deviceInterview, payloadDone);
                const type = status === 'successful' ? 'log' : 'error';
                debug[type](`Interview '${device.get('ieeeAddr')}' ${status}`);
            }
        }
    }

    private async onZclData(zclData: ZclDataPayload): Promise<void> {
        debug.log(`Received ZCL data '${JSON.stringify(zclData)}'`);

        const device = await Device.findByNetworkAddress(zclData.networkAddress);
        if (!device) {
            debug.log(`ZCL data is from unknown device with network adress '${zclData.networkAddress}', skipping...`)
            return;
        }

        let endpoint = device.getEndpoint(zclData.endpoint);
        if (!endpoint) {
            debug.log(`ZCL data is from unknown endpoint '${zclData.endpoint}' from device with network adress '${zclData.networkAddress}', creating it...`)
            endpoint = await device.createEndpoint(zclData.endpoint);
        }

        // Parse command for event
        const command = zclData.frame.Header.commandIdentifier;
        let type: MessagePayloadType = undefined;
        let data: KeyValue;
        if (zclData.frame.Header.frameControl.frameType === FrameType.GLOBAL) {
            if (command === Foundation.report.ID) {
                type = 'attributeReport';
                data = ZclFrameConverter.attributeList(zclData.frame);
            } else if (command === Foundation.readRsp.ID) {
                type = 'readResponse';
                data = ZclFrameConverter.attributeList(zclData.frame);
            }
        } else if (zclData.frame.Header.frameControl.frameType === FrameType.SPECIFIC) {
            const command = zclData.frame.getCommand().name;
            if (CommandsLookup[command]) {
                type = CommandsLookup[command];
                data = zclData.frame.Payload;
            } else {
                debug.log(`Skipping command '${command}' because it is missing from the lookup`);
            }
        }

        // Some device report it's modelID through a readResponse or attributeReport
        if ((type === 'readResponse' || type === 'attributeReport') && data.modelId && !device.get('modelID')) {
            await device.set('modelID', data.modelId);
        }

        if (type) {
            const endpoint = device.getEndpoint(zclData.endpoint);
            const linkquality = zclData.linkquality;
            const groupID = zclData.groupID;
            const eventData: MessagePayload = {type, device, endpoint, data, linkquality, groupID};
            this.emit(Events.message, eventData);
        }

        // Send a default response if necessary.
        if (!zclData.frame.Header.frameControl.disableDefaultResponse) {
            try {
                await endpoint.defaultResponse(zclData.frame.getCommand().ID, 0, zclData.frame.ClusterID);
            } catch (error) {
                debug.error(`Default response to ${zclData.networkAddress} failed`);
            }
        }
    }
}

export default Controller;