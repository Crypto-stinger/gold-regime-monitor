import WebSocket from "ws";
import { EventEmitter } from "events";
import protobuf from "protobufjs";
import { reportError } from "./system-watchdog";

const DEMO_HOST = "demo.ctraderapi.com";
const LIVE_HOST = "live.ctraderapi.com";
const PORT = 5035;

export enum ProtoOAPayloadType {
  HEARTBEAT_EVENT = 51,
  ERROR_RES = 50,
  APPLICATION_AUTH_REQ = 2100,
  APPLICATION_AUTH_RES = 2101,
  ACCOUNT_AUTH_REQ = 2102,
  ACCOUNT_AUTH_RES = 2103,
  OA_ERROR_RES = 2142,
  NEW_ORDER_REQ = 2106,
  NEW_ORDER_RES = 2107,
  EXECUTION_EVENT = 2126,
  SPOT_EVENT = 2131,
  SUBSCRIBE_SPOTS_REQ = 2127,
  SUBSCRIBE_SPOTS_RES = 2128,
  GET_ACCOUNTS_BY_TOKEN_REQ = 2149,
  GET_ACCOUNTS_BY_TOKEN_RES = 2150,
  TRADER_REQ = 2121,
  TRADER_RES = 2122,
  RECONCILE_REQ = 2124,
  RECONCILE_RES = 2125,
  CLOSE_POSITION_REQ = 2111,
  AMEND_POSITION_SLTP_REQ = 2109,
  ORDER_ERROR_EVENT = 2132,
  SYMBOLS_LIST_REQ = 2114,
  SYMBOLS_LIST_RES = 2115,
  SYMBOL_BY_ID_REQ = 2116,
  SYMBOL_BY_ID_RES = 2117,
  SUBSCRIBE_LIVE_TRENDBAR_REQ = 2161,
  TRENDBAR_EVENT = 2165,
  DEAL_LIST_REQ = 2053,
  DEAL_LIST_RES = 2054,
}

export enum ProtoOAOrderType {
  MARKET = 1,
  LIMIT = 2,
  STOP = 3,
}

export enum ProtoOATradeSide {
  BUY = 1,
  SELL = 2,
}

export enum ProtoOATrendbarPeriod {
  M1 = 1,
  M5 = 5,
  M15 = 15,
  M30 = 30,
  H1 = 60,
  H4 = 240,
  D1 = 1440,
}

export interface CTraderConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  accountId: number;
  isLive: boolean;
}

export interface SpotPrice {
  symbolId: number;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface Position {
  positionId: number;
  symbolId: number;
  tradeSide: number;
  volume: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl: number;
  openTimestamp: number;
}

export interface TradeSignal {
  side: "buy" | "sell";
  symbolId: number;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  label: string;
}

type MessageCallback = (payloadType: number, payload: Buffer, clientMsgId?: string) => void;

function buildProtoRoot(): protobuf.Root {
  const root = new protobuf.Root();

  root.add(new protobuf.Type("ProtoMessage")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("payload", 2, "bytes"))
    .add(new protobuf.Field("clientMsgId", 3, "string"))
  );

  root.add(new protobuf.Type("ProtoOAApplicationAuthReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("clientId", 2, "string"))
    .add(new protobuf.Field("clientSecret", 3, "string"))
  );

  root.add(new protobuf.Type("ProtoOAApplicationAuthRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
  );

  root.add(new protobuf.Type("ProtoOAAccountAuthReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("accessToken", 3, "string"))
  );

  root.add(new protobuf.Type("ProtoOAAccountAuthRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
  );

  root.add(new protobuf.Type("ProtoOAErrorRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("errorCode", 3, "string"))
    .add(new protobuf.Field("description", 4, "string"))
    .add(new protobuf.Field("maintenanceEndTimestamp", 5, "int64"))
  );

  root.add(new protobuf.Type("ProtoErrorRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("errorCode", 2, "string"))
    .add(new protobuf.Field("description", 3, "string"))
  );

  root.add(new protobuf.Type("ProtoHeartbeatEvent")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
  );

  root.add(new protobuf.Type("ProtoOASubscribeSpotsReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbolId", 3, "int64", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOASubscribeSpotsRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
  );

  root.add(new protobuf.Type("ProtoOASpotEvent")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbolId", 3, "int64"))
    .add(new protobuf.Field("bid", 4, "uint64"))
    .add(new protobuf.Field("ask", 5, "uint64"))
    .add(new protobuf.Field("trendbar", 6, "ProtoOATrendbar", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOATrendbar")
    .add(new protobuf.Field("volume", 3, "int64"))
    .add(new protobuf.Field("period", 4, "uint32"))
    .add(new protobuf.Field("low", 5, "int64"))
    .add(new protobuf.Field("deltaOpen", 7, "uint64"))
    .add(new protobuf.Field("deltaClose", 8, "uint64"))
    .add(new protobuf.Field("deltaHigh", 9, "uint64"))
    .add(new protobuf.Field("utcTimestampInMinutes", 10, "uint32"))
  );

  root.add(new protobuf.Type("ProtoOAGetAccountListByAccessTokenReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("accessToken", 2, "string"))
  );

  root.add(new protobuf.Type("ProtoOACtidTraderAccount")
    .add(new protobuf.Field("ctidTraderAccountId", 1, "uint64"))
    .add(new protobuf.Field("isLive", 2, "bool"))
    .add(new protobuf.Field("traderLogin", 3, "int64"))
    .add(new protobuf.Field("lastClosingDealTimestamp", 4, "int64"))
    .add(new protobuf.Field("lastBalanceUpdateTimestamp", 5, "int64"))
    .add(new protobuf.Field("brokerName", 6, "string"))
  );

  root.add(new protobuf.Type("ProtoOAGetAccountListByAccessTokenRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("accessToken", 2, "string"))
    .add(new protobuf.Field("permissionScope", 3, "uint32"))
    .add(new protobuf.Field("ctidTraderAccount", 4, "ProtoOACtidTraderAccount", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOATraderReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
  );

  root.add(new protobuf.Type("ProtoOATrader")
    .add(new protobuf.Field("ctidTraderAccountId", 1, "int64"))
    .add(new protobuf.Field("balance", 2, "int64"))
    .add(new protobuf.Field("balanceVersion", 3, "int64"))
    .add(new protobuf.Field("depositAssetId", 4, "int64"))
    .add(new protobuf.Field("leverageInCents", 7, "int64"))
    .add(new protobuf.Field("registrationTimestamp", 8, "int64"))
  );

  root.add(new protobuf.Type("ProtoOATraderRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("trader", 3, "ProtoOATrader"))
  );

  root.add(new protobuf.Type("ProtoOASymbol")
    .add(new protobuf.Field("symbolId", 1, "int64"))
    .add(new protobuf.Field("digits", 2, "int32"))
    .add(new protobuf.Field("pipPosition", 3, "int32"))
    .add(new protobuf.Field("symbolName", 13, "string"))
    .add(new protobuf.Field("description", 16, "string"))
  );

  root.add(new protobuf.Type("ProtoOASymbolByIdReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbolId", 3, "int64", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOASymbolByIdRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbol", 3, "ProtoOASymbol", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOALightSymbol")
    .add(new protobuf.Field("symbolId", 1, "int64"))
    .add(new protobuf.Field("symbolName", 2, "string"))
    .add(new protobuf.Field("enabled", 3, "bool"))
    .add(new protobuf.Field("baseAssetId", 4, "int64"))
    .add(new protobuf.Field("quoteAssetId", 5, "int64"))
    .add(new protobuf.Field("symbolCategoryId", 6, "int64"))
    .add(new protobuf.Field("description", 7, "string"))
  );

  root.add(new protobuf.Type("ProtoOASymbolsListReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
  );

  root.add(new protobuf.Type("ProtoOASymbolsListRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbol", 3, "ProtoOALightSymbol", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOAReconcileReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
  );

  root.add(new protobuf.Type("ProtoOATradeData")
    .add(new protobuf.Field("symbolId", 1, "int64"))
    .add(new protobuf.Field("volume", 2, "int64"))
    .add(new protobuf.Field("tradeSide", 3, "int32"))
    .add(new protobuf.Field("openTimestamp", 4, "int64"))
    .add(new protobuf.Field("label", 5, "string"))
    .add(new protobuf.Field("guaranteedStopLoss", 6, "bool"))
    .add(new protobuf.Field("comment", 7, "string"))
    .add(new protobuf.Field("measurementUnits", 8, "string"))
    .add(new protobuf.Field("closeTimestamp", 9, "uint64"))
  );

  root.add(new protobuf.Type("ProtoOAPosition")
    .add(new protobuf.Field("positionId", 1, "int64"))
    .add(new protobuf.Field("tradeData", 2, "ProtoOATradeData"))
    .add(new protobuf.Field("positionStatus", 3, "int32"))
    .add(new protobuf.Field("swap", 4, "int64"))
    .add(new protobuf.Field("price", 5, "double"))
    .add(new protobuf.Field("stopLoss", 6, "double"))
    .add(new protobuf.Field("takeProfit", 7, "double"))
    .add(new protobuf.Field("utcLastUpdateTimestamp", 8, "int64"))
    .add(new protobuf.Field("commission", 9, "int64"))
    .add(new protobuf.Field("marginRate", 10, "double"))
    .add(new protobuf.Field("mirroringCommission", 11, "int64"))
    .add(new protobuf.Field("guaranteedStopLoss", 12, "bool"))
    .add(new protobuf.Field("usedMargin", 13, "uint64"))
    .add(new protobuf.Field("stopLossTriggerMethod", 14, "int32"))
    .add(new protobuf.Field("moneyDigits", 15, "uint32"))
    .add(new protobuf.Field("trailingStopLoss", 16, "bool"))
  );

  root.add(new protobuf.Type("ProtoOAOrder")
    .add(new protobuf.Field("orderId", 1, "int64"))
    .add(new protobuf.Field("tradeData", 2, "ProtoOATradeData"))
    .add(new protobuf.Field("orderType", 3, "int32"))
    .add(new protobuf.Field("orderStatus", 4, "int32"))
    .add(new protobuf.Field("expirationTimestamp", 6, "int64"))
    .add(new protobuf.Field("executionPrice", 7, "double"))
    .add(new protobuf.Field("executedVolume", 8, "int64"))
    .add(new protobuf.Field("utcLastUpdateTimestamp", 9, "int64"))
    .add(new protobuf.Field("baseSlippagePrice", 10, "double"))
    .add(new protobuf.Field("slippageInPoints", 11, "int64"))
    .add(new protobuf.Field("closingOrder", 12, "bool"))
    .add(new protobuf.Field("limitPrice", 13, "double"))
    .add(new protobuf.Field("stopPrice", 14, "double"))
    .add(new protobuf.Field("stopLoss", 15, "double"))
    .add(new protobuf.Field("takeProfit", 16, "double"))
    .add(new protobuf.Field("clientOrderId", 17, "string"))
    .add(new protobuf.Field("timeInForce", 18, "int32"))
    .add(new protobuf.Field("positionId", 19, "int64"))
    .add(new protobuf.Field("relativeStopLoss", 20, "int64"))
    .add(new protobuf.Field("relativeTakeProfit", 21, "int64"))
    .add(new protobuf.Field("isStopOut", 22, "bool"))
    .add(new protobuf.Field("trailingStopLoss", 23, "bool"))
    .add(new protobuf.Field("stopTriggerMethod", 24, "int32"))
  );

  root.add(new protobuf.Type("ProtoOAReconcileRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("position", 3, "ProtoOAPosition", "repeated"))
    .add(new protobuf.Field("order", 4, "ProtoOAOrder", "repeated"))
  );

  root.add(new protobuf.Type("ProtoOANewOrderReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbolId", 3, "int64"))
    .add(new protobuf.Field("orderType", 4, "int32"))
    .add(new protobuf.Field("tradeSide", 5, "int32"))
    .add(new protobuf.Field("volume", 6, "int64"))
    .add(new protobuf.Field("limitPrice", 7, "double"))
    .add(new protobuf.Field("stopPrice", 8, "double"))
    .add(new protobuf.Field("timeInForce", 9, "int32"))
    .add(new protobuf.Field("expirationTimestamp", 10, "int64"))
    .add(new protobuf.Field("stopLoss", 11, "double"))
    .add(new protobuf.Field("takeProfit", 12, "double"))
    .add(new protobuf.Field("comment", 13, "string"))
    .add(new protobuf.Field("baseSlippagePrice", 14, "double"))
    .add(new protobuf.Field("slippageInPoints", 15, "int32"))
    .add(new protobuf.Field("label", 16, "string"))
    .add(new protobuf.Field("positionId", 17, "int64"))
    .add(new protobuf.Field("clientOrderId", 18, "string"))
    .add(new protobuf.Field("relativeStopLoss", 19, "int64"))
    .add(new protobuf.Field("relativeTakeProfit", 20, "int64"))
    .add(new protobuf.Field("guaranteedStopLoss", 21, "bool"))
    .add(new protobuf.Field("trailingStopLoss", 22, "bool"))
    .add(new protobuf.Field("stopTriggerMethod", 23, "int32"))
  );

  root.add(new protobuf.Type("ProtoOAClosePositionReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("positionId", 3, "int64"))
    .add(new protobuf.Field("volume", 4, "int64"))
  );

  root.add(new protobuf.Type("ProtoOAAmendPositionSLTPReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("positionId", 3, "int64"))
    .add(new protobuf.Field("stopLoss", 4, "double"))
    .add(new protobuf.Field("takeProfit", 5, "double"))
  );

  root.add(new protobuf.Type("ProtoOAClosePositionDetail")
    .add(new protobuf.Field("entryPrice", 1, "double"))
    .add(new protobuf.Field("profit", 2, "int64"))
    .add(new protobuf.Field("swap", 3, "int64"))
    .add(new protobuf.Field("commission", 4, "int64"))
    .add(new protobuf.Field("balance", 5, "int64"))
    .add(new protobuf.Field("closedVolume", 7, "int64"))
  );

  root.add(new protobuf.Type("ProtoOADeal")
    .add(new protobuf.Field("dealId", 1, "int64"))
    .add(new protobuf.Field("orderId", 2, "int64"))
    .add(new protobuf.Field("positionId", 3, "int64"))
    .add(new protobuf.Field("volume", 4, "int64"))
    .add(new protobuf.Field("filledVolume", 5, "int64"))
    .add(new protobuf.Field("symbolId", 6, "int64"))
    .add(new protobuf.Field("createTimestamp", 7, "int64"))
    .add(new protobuf.Field("executionTimestamp", 8, "int64"))
    .add(new protobuf.Field("dealStatus", 9, "int32"))
    .add(new protobuf.Field("executionPrice", 10, "double"))
    .add(new protobuf.Field("tradeSide", 11, "int32"))
    .add(new protobuf.Field("closePositionDetail", 12, "ProtoOAClosePositionDetail"))
    .add(new protobuf.Field("closePrice", 15, "double"))
    .add(new protobuf.Field("commission", 16, "int64"))
  );

  root.add(new protobuf.Type("ProtoOAExecutionEvent")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("executionType", 3, "int32"))
    .add(new protobuf.Field("position", 4, "ProtoOAPosition"))
    .add(new protobuf.Field("order", 5, "ProtoOAOrder"))
    .add(new protobuf.Field("deal", 6, "ProtoOADeal"))
    .add(new protobuf.Field("isServerEvent", 9, "bool"))
    .add(new protobuf.Field("errorCode", 11, "string"))
  );

  root.add(new protobuf.Type("ProtoOAOrderErrorEvent")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("orderType", 3, "int32"))
    .add(new protobuf.Field("tradeSide", 4, "int32"))
    .add(new protobuf.Field("errorCode", 5, "string"))
    .add(new protobuf.Field("orderId", 6, "fixed64"))
    .add(new protobuf.Field("positionId", 7, "int64"))
    .add(new protobuf.Field("description", 8, "string"))
  );

  root.add(new protobuf.Type("ProtoOASubscribeLiveTrendbarReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("symbolId", 3, "int64"))
    .add(new protobuf.Field("period", 4, "int32"))
  );

  root.add(new protobuf.Type("ProtoOADealListReq")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("fromTimestamp", 3, "int64"))
    .add(new protobuf.Field("toTimestamp", 4, "int64"))
    .add(new protobuf.Field("maxRows", 5, "int32"))
  );

  root.add(new protobuf.Type("ProtoOADealListRes")
    .add(new protobuf.Field("payloadType", 1, "uint32"))
    .add(new protobuf.Field("ctidTraderAccountId", 2, "int64"))
    .add(new protobuf.Field("deal", 3, "ProtoOADeal", "repeated"))
    .add(new protobuf.Field("hasMore", 4, "bool"))
  );

  root.resolveAll();
  return root;
}

const payloadTypeToMessageName: Record<number, string> = {
  [ProtoOAPayloadType.HEARTBEAT_EVENT]: "ProtoHeartbeatEvent",
  [ProtoOAPayloadType.ERROR_RES]: "ProtoErrorRes",
  [ProtoOAPayloadType.APPLICATION_AUTH_REQ]: "ProtoOAApplicationAuthReq",
  [ProtoOAPayloadType.APPLICATION_AUTH_RES]: "ProtoOAApplicationAuthRes",
  [ProtoOAPayloadType.ACCOUNT_AUTH_REQ]: "ProtoOAAccountAuthReq",
  [ProtoOAPayloadType.ACCOUNT_AUTH_RES]: "ProtoOAAccountAuthRes",
  [ProtoOAPayloadType.OA_ERROR_RES]: "ProtoOAErrorRes",
  [ProtoOAPayloadType.SUBSCRIBE_SPOTS_REQ]: "ProtoOASubscribeSpotsReq",
  [ProtoOAPayloadType.SUBSCRIBE_SPOTS_RES]: "ProtoOASubscribeSpotsRes",
  [ProtoOAPayloadType.SPOT_EVENT]: "ProtoOASpotEvent",
  [ProtoOAPayloadType.GET_ACCOUNTS_BY_TOKEN_REQ]: "ProtoOAGetAccountListByAccessTokenReq",
  [ProtoOAPayloadType.GET_ACCOUNTS_BY_TOKEN_RES]: "ProtoOAGetAccountListByAccessTokenRes",
  [ProtoOAPayloadType.TRADER_REQ]: "ProtoOATraderReq",
  [ProtoOAPayloadType.TRADER_RES]: "ProtoOATraderRes",
  [ProtoOAPayloadType.SYMBOLS_LIST_REQ]: "ProtoOASymbolsListReq",
  [ProtoOAPayloadType.SYMBOLS_LIST_RES]: "ProtoOASymbolsListRes",
  [ProtoOAPayloadType.RECONCILE_REQ]: "ProtoOAReconcileReq",
  [ProtoOAPayloadType.RECONCILE_RES]: "ProtoOAReconcileRes",
  [ProtoOAPayloadType.NEW_ORDER_REQ]: "ProtoOANewOrderReq",
  [ProtoOAPayloadType.EXECUTION_EVENT]: "ProtoOAExecutionEvent",
  [ProtoOAPayloadType.ORDER_ERROR_EVENT]: "ProtoOAOrderErrorEvent",
  [ProtoOAPayloadType.CLOSE_POSITION_REQ]: "ProtoOAClosePositionReq",
  [ProtoOAPayloadType.AMEND_POSITION_SLTP_REQ]: "ProtoOAAmendPositionSLTPReq",
  [ProtoOAPayloadType.SUBSCRIBE_LIVE_TRENDBAR_REQ]: "ProtoOASubscribeLiveTrendbarReq",
  [ProtoOAPayloadType.SYMBOL_BY_ID_REQ]: "ProtoOASymbolByIdReq",
  [ProtoOAPayloadType.SYMBOL_BY_ID_RES]: "ProtoOASymbolByIdRes",
  [ProtoOAPayloadType.DEAL_LIST_REQ]: "ProtoOADealListReq",
  [ProtoOAPayloadType.DEAL_LIST_RES]: "ProtoOADealListRes",
};

export class CTraderAPI extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: CTraderConfig;
  private connected = false;
  private authenticated = false;
  private accountAuthed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private _connecting = false;
  private _reconnectAttempts = 0;
  private _intentionalDisconnect = false;
  private messageId = 1;
  private pendingCallbacks = new Map<string, (payloadType: number, decoded: any) => void>();
  private positions = new Map<number, Position>();
  private lastSpot: SpotPrice | null = null;
  private xauSymbolId = 0;
  private xauDigits = 2;
  private _balance: number | null = null;
  private _leverage: number | null = null;
  private _traderLogin: string | null = null;
  private _cachedAccounts: any[] | null = null;
  private root: protobuf.Root;
  private ProtoMessage: protobuf.Type;
  constructor(config: CTraderConfig) {
    super();
    this.config = config;
    this.root = buildProtoRoot();
    this.ProtoMessage = this.root.lookupType("ProtoMessage");
  }

  get isConnected() { return this.connected && this.authenticated && this.accountAuthed; }
  get configAccountId() { return this.config.accountId; }
  get traderLogin() { return this._traderLogin; }
  get cachedAccounts() { return this._cachedAccounts; }
  get currentPositions() { return Array.from(this.positions.values()); }
  get currentSpot() { return this.lastSpot; }
  get symbolId() { return this.xauSymbolId; }

  private encodeMessage(payloadType: number, innerFields: Record<string, any>, clientMsgId?: string): Buffer {
    const msgName = payloadTypeToMessageName[payloadType];
    if (!msgName) throw new Error(`Unknown payloadType: ${payloadType}`);

    const InnerType = this.root.lookupType(msgName);
    const innerMsg = InnerType.create({ payloadType, ...innerFields });
    const innerBuf = InnerType.encode(innerMsg).finish();

    const protoMsg = this.ProtoMessage.create({
      payloadType,
      payload: innerBuf,
      clientMsgId: clientMsgId || "",
    });
    const protoBuf = this.ProtoMessage.encode(protoMsg).finish();
    return Buffer.from(protoBuf);
  }

  private decodeFrame(data: Buffer): { payloadType: number; payload: any; clientMsgId: string } | null {
    try {
      const protoMsg = this.ProtoMessage.decode(data) as any;
      const payloadType: number = protoMsg.payloadType;
      const clientMsgId: string = protoMsg.clientMsgId || "";

      let decoded: any = {};
      if (protoMsg.payload && protoMsg.payload.length > 0) {
        const msgName = payloadTypeToMessageName[payloadType];
        if (msgName) {
          try {
            const InnerType = this.root.lookupType(msgName);
            const reader = protobuf.Reader.create(protoMsg.payload);
            const rawDecoded = InnerType.decode(reader, protoMsg.payload.length);
            decoded = InnerType.toObject(rawDecoded, {
              longs: Number,
              enums: Number,
              defaults: true,
            });
          } catch (decErr: any) {
            try {
              const partial: any = {};
              const buf = protoMsg.payload;
              let pos = 0;
              const readVarint = () => {
                let val = 0, shift = 0;
                while (pos < buf.length) {
                  const b = buf[pos++];
                  val |= (b & 0x7f) << shift;
                  shift += 7;
                  if (!(b & 0x80)) break;
                }
                return val;
              };
              while (pos < buf.length) {
                const tag = readVarint();
                const fieldNum = tag >>> 3;
                const wireType = tag & 0x7;
                if (wireType === 0) {
                  partial[`field_${fieldNum}`] = readVarint();
                } else if (wireType === 1) {
                  pos += 8;
                } else if (wireType === 2) {
                  const len = readVarint();
                  const strBytes = buf.slice(pos, pos + len);
                  try {
                    partial[`field_${fieldNum}`] = strBytes.toString("utf8");
                  } catch { /* skip non-utf8 */ }
                  pos += len;
                } else if (wireType === 3 || wireType === 4) {
                  continue;
                } else if (wireType === 5) {
                  pos += 4;
                } else {
                  break;
                }
              }
              const errorCode = partial.field_5 || partial.field_3;
              const description = partial.field_8 || partial.field_7 || partial.field_6;
              decoded = { ...partial, errorCode, description };
              console.warn(`[cTrader] Partial decode of ${msgName}: errorCode=${errorCode}, description=${description}`);
            } catch {
              console.error(`[cTrader] Failed to decode ${msgName}:`, decErr.message);
              decoded = { rawPayload: true, payloadBytes: protoMsg.payload.length, error: decErr.message };
            }
          }
        }
      }
      return { payloadType, payload: decoded, clientMsgId };
    } catch (e: any) {
      console.error("[cTrader] Failed to decode frame:", e.message);
      return null;
    }
  }

  async connectAppOnly(): Promise<void> {
    const host = this.config.isLive ? LIVE_HOST : DEMO_HOST;
    const url = `wss://${host}:${PORT}`;

    return new Promise((resolve, reject) => {
      console.log(`[cTrader] Connecting (app-only) to ${url}...`);
      this.ws = new WebSocket(url);
      this.ws.binaryType = "nodebuffer";

      const connectTimeout = setTimeout(() => {
        reject(new Error("Connection timeout after 15s"));
        this.ws?.close();
      }, 15000);

      this.ws.on("open", () => {
        console.log("[cTrader] WebSocket connected");
        this.connected = true;
        this.startHeartbeat();
        this.authenticateApp()
          .then(() => {
            clearTimeout(connectTimeout);
            console.log("[cTrader] App authenticated (no account auth)");
            resolve();
          })
          .catch((err) => {
            clearTimeout(connectTimeout);
            reject(err);
          });
      });

      this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        let buf: Buffer;
        if (Buffer.isBuffer(data)) buf = data;
        else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
        else buf = Buffer.concat(data);
        const decoded = this.decodeFrame(buf);
        if (decoded) this.handleMessage(decoded.payloadType, decoded.payload, decoded.clientMsgId);
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.authenticated = false;
      });

      this.ws.on("error", (err) => {
        if (!this.connected) {
          clearTimeout(connectTimeout);
          reject(err);
        }
      });
    });
  }

  async connect(): Promise<void> {
    if (this._connecting) {
      console.log("[cTrader] Connection already in progress, skipping duplicate attempt");
      return;
    }
    this._connecting = true;
    this._intentionalDisconnect = false;
    const host = this.config.isLive ? LIVE_HOST : DEMO_HOST;
    const url = `wss://${host}:${PORT}`;

    return new Promise((resolve, reject) => {
      console.log(`[cTrader] Connecting to ${url}...`);
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
        this.ws = null;
      }
      this.ws = new WebSocket(url);
      this.ws.binaryType = "nodebuffer";

      const connectTimeout = setTimeout(() => {
        this._connecting = false;
        reject(new Error("Connection timeout after 30s"));
        try { this.ws?.close(); } catch {}
      }, 30000);

      this.ws.on("open", () => {
        console.log("[cTrader] WebSocket connected");
        this.connected = true;
        this.startHeartbeat();
        this.authenticateApp()
          .then(() => this.authenticateAccount())
          .then(() => {
            clearTimeout(connectTimeout);
            this._connecting = false;
            this._reconnectAttempts = 0;
            console.log("[cTrader] Fully authenticated");
            this.getAccounts().catch(() => {});
            this.emit("ready");
            resolve();
          })
          .catch((err) => {
            clearTimeout(connectTimeout);
            this._connecting = false;
            reject(err);
          });
      });

      this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        let buf: Buffer;
        if (Buffer.isBuffer(data)) {
          buf = data;
        } else if (data instanceof ArrayBuffer) {
          buf = Buffer.from(data);
        } else {
          buf = Buffer.concat(data);
        }
        const decoded = this.decodeFrame(buf);
        if (decoded) {
          this.handleMessage(decoded.payloadType, decoded.payload, decoded.clientMsgId);
        }
      });

      this.ws.on("close", () => {
        console.log("[cTrader] WebSocket closed");
        this.connected = false;
        this.authenticated = false;
        this.accountAuthed = false;
        this._connecting = false;
        this.emit("disconnected");
        if (!this._intentionalDisconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        console.error("[cTrader] WebSocket error:", err.message);
        reportError("ctrader", `WebSocket error: ${err.message}`);
        this.emit("error", err);
        if (!this.connected) {
          clearTimeout(connectTimeout);
          this._connecting = false;
          reject(err);
        }
      });
    });
  }

  disconnect() {
    this._intentionalDisconnect = true;
    this._connecting = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.accountAuthed = false;
    this._reconnectAttempts = 0;
    console.log("[cTrader] Disconnected");
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
        this.sendRaw(ProtoOAPayloadType.HEARTBEAT_EVENT, {});
      }
    }, 10000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this._intentionalDisconnect) return;
    this._reconnectAttempts++;
    if (this._reconnectAttempts > 5) {
      console.log(`[cTrader] Stopping internal reconnect after ${this._reconnectAttempts} attempts — relying on watchdog`);
      return;
    }
    const delay = Math.min(30000 * Math.pow(2, this._reconnectAttempts - 1), 300000);
    console.log(`[cTrader] Scheduling reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${this._reconnectAttempts}/5)...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        this._spotsSubscribed = false;
        this._trendbarsSubscribed = false;
        await this.connect();
        if (this.xauSymbolId > 0) {
          await this.subscribeSpots(this.xauSymbolId);
          await this.subscribeTrendbars(this.xauSymbolId, ProtoOATrendbarPeriod.H1);
          console.log("[cTrader] Re-subscribed to spots and trendbars after reconnect");
        }
        await this.reconcilePositions();
        console.log(`[cTrader] Reconnected successfully after ${this._reconnectAttempts} attempt(s)`);
        this._reconnectAttempts = 0;
        this.emit("reconnected");
      } catch (e: any) {
        const isRateLimit = e.message?.includes("BLOCKED_PAYLOAD_TYPE") || e.message?.includes("rate limit");
        console.error(`[cTrader] Reconnect attempt ${this._reconnectAttempts}/5 failed: ${e.message}`);
        if (isRateLimit) {
          console.log("[cTrader] Rate-limited — stopping internal reconnect, relying on watchdog");
          return;
        }
        this.scheduleReconnect();
      }
    }, delay);
  }

  private sendRaw(payloadType: number, fields: Record<string, any>, clientMsgId?: string): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    const msgId = clientMsgId || `msg_${this.messageId++}`;
    const buf = this.encodeMessage(payloadType, fields, msgId);
    this.ws.send(buf);
    return msgId;
  }

  private sendAndWait(payloadType: number, fields: Record<string, any>, timeout = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const msgId = this.sendRaw(payloadType, fields);
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(msgId);
        reject(new Error(`Timeout waiting for response to ${payloadType} (${payloadTypeToMessageName[payloadType] || "unknown"})`));
      }, timeout);

      this.pendingCallbacks.set(msgId, (resPayloadType: number, decoded: any) => {
        clearTimeout(timer);
        this.pendingCallbacks.delete(msgId);
        if (resPayloadType === ProtoOAPayloadType.OA_ERROR_RES || resPayloadType === ProtoOAPayloadType.ERROR_RES) {
          reject(new Error(`cTrader error: ${decoded?.errorCode} - ${decoded?.description}`));
        } else if (resPayloadType === ProtoOAPayloadType.ORDER_ERROR_EVENT) {
          reject(new Error(`Order rejected: ${decoded?.errorCode} - ${decoded?.description}`));
        } else {
          resolve(decoded);
        }
      });
    });
  }

  private handleMessage(payloadType: number, payload: any, clientMsgId: string) {
    if (clientMsgId && this.pendingCallbacks.has(clientMsgId)) {
      this.pendingCallbacks.get(clientMsgId)!(payloadType, payload);
      return;
    }

    switch (payloadType) {
      case ProtoOAPayloadType.HEARTBEAT_EVENT:
        break;

      case ProtoOAPayloadType.SPOT_EVENT:
        this.handleSpotEvent(payload);
        break;

      case ProtoOAPayloadType.EXECUTION_EVENT:
        this.handleExecutionEvent(payload);
        break;

      case ProtoOAPayloadType.ORDER_ERROR_EVENT:
        console.error("[cTrader] Order error:", payload?.errorCode, payload?.description);
        reportError("ctrader", `Order error: ${payload?.errorCode} ${payload?.description || ""}`);
        this.emit("orderError", payload);
        break;

      case ProtoOAPayloadType.OA_ERROR_RES:
      case ProtoOAPayloadType.ERROR_RES: {
        const errCode = payload?.errorCode || "";
        const errDesc = payload?.description || "";
        const isHarmless = errCode === "UNSUPPORTED_MESSAGE" || errDesc.includes("UNSUPPORTED_MESSAGE");
        if (isHarmless) {
          console.warn("[cTrader] Ignoring unsupported message:", errDesc);
        } else {
          console.error("[cTrader] Error:", errCode, errDesc);
          reportError("ctrader", `API error: ${errCode} ${errDesc}`);
        }
        this.emit("apiError", payload);
        break;
      }

      case ProtoOAPayloadType.TRENDBAR_EVENT:
        this.emit("trendbar", payload);
        break;

      default:
        break;
    }
  }

  private spotLogCount = 0;
  private spotDigitsCalibrated = false;
  private _spotsSubscribed = false;
  private _trendbarsSubscribed = false;
  get spotsSubscribed() { return this._spotsSubscribed; }
  private lastRawBid = 0;
  private lastRawAsk = 0;
  private handleSpotEvent(payload: any) {
    if (!payload) return;
    if (payload.bid && payload.bid > 0) this.lastRawBid = payload.bid;
    if (payload.ask && payload.ask > 0) this.lastRawAsk = payload.ask;
    const rawBid = this.lastRawBid;
    const rawAsk = this.lastRawAsk;

    if (!this.spotDigitsCalibrated && rawBid > 0) {
      for (let d = 0; d <= 10; d++) {
        const testPrice = rawBid / Math.pow(10, d);
        if (testPrice >= 1000 && testPrice <= 15000) {
          if (d !== this.xauDigits) {
            console.log(`[cTrader] Auto-calibrated spot digits: ${this.xauDigits} → ${d} (test price=$${testPrice.toFixed(2)})`);
            this.xauDigits = d;
          }
          break;
        }
      }
      this.spotDigitsCalibrated = true;
    }

    if (rawBid === 0 && rawAsk === 0) return;

    const pipFactor = Math.pow(10, this.xauDigits);
    const spot: SpotPrice = {
      symbolId: payload.symbolId || 0,
      bid: rawBid / pipFactor,
      ask: rawAsk / pipFactor,
      timestamp: Date.now(),
    };
    if (this.spotLogCount < 5) {
      console.log(`[cTrader] Spot tick #${this.spotLogCount + 1}: rawBid=${rawBid} rawAsk=${rawAsk} digits=${this.xauDigits} pipFactor=${pipFactor} → bid=${spot.bid.toFixed(2)} ask=${spot.ask.toFixed(2)}`);
      this.spotLogCount++;
    }
    this.lastSpot = spot;
    this.emit("spot", spot);
  }

  private handleExecutionEvent(payload: any) {
    if (!payload) return;
    console.log("[cTrader] Execution event type:", payload.executionType, payload.errorCode ? `error: ${payload.errorCode}` : "");

    if (payload.position) {
      const pos = payload.position;
      const status = pos.positionStatus;
      if (status === 1) {
        this.positions.set(pos.positionId, {
          positionId: pos.positionId,
          symbolId: pos.tradeData?.symbolId || 0,
          tradeSide: pos.tradeData?.tradeSide || 0,
          volume: pos.tradeData?.volume || 0,
          entryPrice: pos.price || 0,
          stopLoss: pos.stopLoss || undefined,
          takeProfit: pos.takeProfit || undefined,
          unrealizedPnl: 0,
          openTimestamp: pos.tradeData?.openTimestamp || Date.now(),
        });
      } else if (status === 2) {
        this.positions.delete(pos.positionId);
      }
    }

    this.emit("execution", payload);
  }

  private async authenticateApp(): Promise<void> {
    console.log("[cTrader] Authenticating application...");
    await this.sendAndWait(ProtoOAPayloadType.APPLICATION_AUTH_REQ, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    this.authenticated = true;
    console.log("[cTrader] App authenticated");
  }

  private async authenticateAccount(): Promise<void> {
    console.log("[cTrader] Authenticating account...");
    await new Promise(resolve => setTimeout(resolve, 500));
    await this.sendAndWait(ProtoOAPayloadType.ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: this.config.accountId,
      accessToken: this.config.accessToken,
    }, 15000);
    this.accountAuthed = true;
    console.log("[cTrader] Account authenticated:", this.config.accountId);
  }

  async getAccounts(): Promise<any[]> {
    const res = await this.sendAndWait(ProtoOAPayloadType.GET_ACCOUNTS_BY_TOKEN_REQ, {
      accessToken: this.config.accessToken,
    });
    const accounts = res?.ctidTraderAccount || [];
    this._cachedAccounts = accounts;
    const match = accounts.find((a: any) => String(a.ctidTraderAccountId) === String(this.config.accountId));
    if (match?.traderLogin) {
      this._traderLogin = String(match.traderLogin);
      console.log(`[cTrader] TraderLogin for account ${this.config.accountId}: ${this._traderLogin}`);
    }
    console.log(`[cTrader] GetAccounts: found ${accounts.length} accounts`);
    return accounts;
  }

  async getTraderInfo(): Promise<any> {
    const res = await this.sendAndWait(ProtoOAPayloadType.TRADER_REQ, {
      ctidTraderAccountId: this.config.accountId,
    });
    const trader = res?.trader;
    if (trader?.balance != null) {
      this._balance = trader.balance / 100;
    }
    if (trader?.leverageInCents != null) {
      this._leverage = trader.leverageInCents / 100;
    }
    return trader;
  }

  async refreshBalance(): Promise<number | null> {
    await this.getTraderInfo();
    return this._balance;
  }

  async reconcilePositions(): Promise<any> {
    const res = await this.sendAndWait(ProtoOAPayloadType.RECONCILE_REQ, {
      ctidTraderAccountId: this.config.accountId,
    });
    const positions = res?.position || [];
    this.positions.clear();
    for (const pos of positions) {
      if (pos.positionStatus === 1) {
        this.positions.set(pos.positionId, {
          positionId: pos.positionId,
          symbolId: pos.tradeData?.symbolId || 0,
          tradeSide: pos.tradeData?.tradeSide || 0,
          volume: pos.tradeData?.volume || 0,
          entryPrice: pos.price || 0,
          stopLoss: pos.stopLoss || undefined,
          takeProfit: pos.takeProfit || undefined,
          unrealizedPnl: 0,
          openTimestamp: pos.tradeData?.openTimestamp || Date.now(),
        });
      }
    }
    return positions;
  }

  async findXAUUSDSymbol(): Promise<number> {
    const res = await this.sendAndWait(ProtoOAPayloadType.SYMBOLS_LIST_REQ, {
      ctidTraderAccountId: this.config.accountId,
    });
    const symbols = res?.symbol || [];
    console.log(`[cTrader] Symbols list: ${symbols.length} available`);
    let foundSymbol: any = null;
    foundSymbol = symbols.find((s: any) => s.symbolName === "XAUUSD");
    if (!foundSymbol) foundSymbol = symbols.find((s: any) => s.symbolName === "XAU/USD");
    if (!foundSymbol) foundSymbol = symbols.find((s: any) => s.symbolName?.includes("XAU") && s.symbolName?.includes("USD"));
    if (!foundSymbol) {
      const goldSymbols = symbols.filter((s: any) => s.symbolName?.includes("XAU"));
      throw new Error("XAUUSD symbol not found on this account. Available gold symbols: " +
        (goldSymbols.length > 0 ? goldSymbols.map((s: any) => s.symbolName).join(", ") : "none"));
    }

    this.xauSymbolId = foundSymbol.symbolId;
    console.log(`[cTrader] Found ${foundSymbol.symbolName}: ID=${foundSymbol.symbolId}`);

    try {
      const detailRes = await this.sendAndWait(ProtoOAPayloadType.SYMBOL_BY_ID_REQ, {
        ctidTraderAccountId: this.config.accountId,
        symbolId: [foundSymbol.symbolId],
      });
      const symbolDetails = detailRes?.symbol?.[0];
      if (symbolDetails?.digits) {
        this.xauDigits = symbolDetails.digits;
        console.log(`[cTrader] XAUUSD digits=${this.xauDigits}, pipPosition=${symbolDetails.pipPosition}`);
      } else {
        console.log(`[cTrader] Could not get digits, using default=${this.xauDigits}. Detail response:`, JSON.stringify(detailRes).substring(0, 300));
      }
    } catch (e: any) {
      console.warn(`[cTrader] Failed to get symbol details, using default digits=${this.xauDigits}:`, e.message);
    }

    return foundSymbol.symbolId;
  }

  async subscribeSpots(symbolId: number): Promise<void> {
    if (this._spotsSubscribed) {
      console.log(`[cTrader] Spots already subscribed for symbol ${symbolId}, skipping`);
      return;
    }
    await this.sendAndWait(ProtoOAPayloadType.SUBSCRIBE_SPOTS_REQ, {
      ctidTraderAccountId: this.config.accountId,
      symbolId: [symbolId],
    });
    this._spotsSubscribed = true;
    console.log(`[cTrader] Subscribed to spots for symbol ${symbolId}`);
  }

  async subscribeTrendbars(symbolId: number, period: ProtoOATrendbarPeriod): Promise<void> {
    if (this._trendbarsSubscribed) {
      console.log(`[cTrader] Trendbars already subscribed for symbol ${symbolId}, skipping`);
      return;
    }
    this.sendRaw(ProtoOAPayloadType.SUBSCRIBE_LIVE_TRENDBAR_REQ, {
      ctidTraderAccountId: this.config.accountId,
      symbolId,
      period,
    });
    this._trendbarsSubscribed = true;
    console.log(`[cTrader] Subscribed to trendbars period=${period} for symbol ${symbolId}`);
  }

  async placeMarketOrder(signal: TradeSignal): Promise<any> {
    const fields: any = {
      ctidTraderAccountId: this.config.accountId,
      symbolId: signal.symbolId,
      orderType: ProtoOAOrderType.MARKET,
      tradeSide: signal.side === "buy" ? ProtoOATradeSide.BUY : ProtoOATradeSide.SELL,
      volume: signal.volume,
      label: signal.label,
    };

    const currentPrice = signal.side === "buy"
      ? (this.lastSpot?.ask || signal.stopLoss + 100)
      : (this.lastSpot?.bid || signal.takeProfit + 100);

    if (signal.stopLoss > 0) {
      const slDistance = Math.abs(currentPrice - signal.stopLoss);
      if (slDistance < 0.01 || isNaN(slDistance)) {
        const msg = `Invalid stop loss: SL=$${signal.stopLoss} price=$${currentPrice} distance=$${slDistance} — stop too close or NaN`;
        console.error(`[cTrader] ${msg}`);
        throw new Error(msg);
      }
      if (signal.side === "buy" && signal.stopLoss >= currentPrice) {
        const msg = `Invalid stop loss for BUY: SL=$${signal.stopLoss} must be below price $${currentPrice}`;
        console.error(`[cTrader] ${msg}`);
        throw new Error(msg);
      }
      if (signal.side === "sell" && signal.stopLoss <= currentPrice) {
        const msg = `Invalid stop loss for SELL: SL=$${signal.stopLoss} must be above price $${currentPrice}`;
        console.error(`[cTrader] ${msg}`);
        throw new Error(msg);
      }
      fields.relativeStopLoss = Math.round(slDistance * 100000);
    }
    if (signal.takeProfit > 0) {
      const tpDistance = Math.abs(signal.takeProfit - currentPrice);
      if (tpDistance < 0.01 || isNaN(tpDistance)) {
        const msg = `Invalid take profit: TP=$${signal.takeProfit} price=$${currentPrice} distance=$${tpDistance} — TP too close or NaN`;
        console.error(`[cTrader] ${msg}`);
        throw new Error(msg);
      }
      if (signal.side === "buy" && signal.takeProfit <= currentPrice) {
        const msg = `Invalid take profit for BUY: TP=$${signal.takeProfit} must be above price $${currentPrice}`;
        console.error(`[cTrader] ${msg}`);
        throw new Error(msg);
      }
      if (signal.side === "sell" && signal.takeProfit >= currentPrice) {
        const msg = `Invalid take profit for SELL: TP=$${signal.takeProfit} must be below price $${currentPrice}`;
        console.error(`[cTrader] ${msg}`);
        throw new Error(msg);
      }
      fields.relativeTakeProfit = Math.round(tpDistance * 100000);
    }

    console.log(`[cTrader] Placing ${signal.side} order: vol=${signal.volume} SL=$${signal.stopLoss} (rel=${fields.relativeStopLoss} units, dist=$${(fields.relativeStopLoss/100000).toFixed(2)}) TP=$${signal.takeProfit} (rel=${fields.relativeTakeProfit} units, dist=$${(fields.relativeTakeProfit/100000).toFixed(2)}) price=$${currentPrice}`);

    return new Promise((resolve, reject) => {
      let settled = false;

      const onOrderError = (payload: any) => {
        if (settled) return;
        settled = true;
        this.removeListener("orderError", onOrderError);
        clearTimeout(fallbackTimer);
        const msg = `Order rejected: ${payload?.errorCode} - ${payload?.description}`;
        console.error("[cTrader]", msg);
        reject(new Error(msg));
      };

      this.on("orderError", onOrderError);

      const fallbackTimer = setTimeout(() => {
        this.removeListener("orderError", onOrderError);
      }, 16000);

      this.sendAndWait(ProtoOAPayloadType.NEW_ORDER_REQ, fields, 15000)
        .then((res) => {
          if (settled) return;
          settled = true;
          this.removeListener("orderError", onOrderError);
          clearTimeout(fallbackTimer);
          console.log("[cTrader] Order result received:", JSON.stringify(res).substring(0, 500));
          resolve(res);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          this.removeListener("orderError", onOrderError);
          clearTimeout(fallbackTimer);
          console.error("[cTrader] Order REJECTED:", err.message || JSON.stringify(err));
          reject(err);
        });
    });
  }

  async closePosition(positionId: number, volume: number): Promise<any> {
    const res = await this.sendAndWait(ProtoOAPayloadType.CLOSE_POSITION_REQ, {
      ctidTraderAccountId: this.config.accountId,
      positionId,
      volume,
    });
    return res;
  }

  private _dealHistorySupported = true;

  async getDealHistory(fromTimestamp?: number, maxRows = 500): Promise<any[]> {
    if (!this.isConnected || !this._dealHistorySupported) return [];
    const now = Date.now();
    const from = fromTimestamp || (now - 365 * 24 * 60 * 60 * 1000);
    try {
      const res = await this.sendAndWait(ProtoOAPayloadType.DEAL_LIST_REQ, {
        ctidTraderAccountId: this.config.accountId,
        fromTimestamp: from,
        toTimestamp: now,
        maxRows,
      }, 15000);
      const deals = res?.deal || [];
      return deals.map((d: any) => ({
        dealId: d.dealId,
        positionId: d.positionId,
        orderId: d.orderId,
        volume: d.volume || d.filledVolume || 0,
        executionPrice: d.executionPrice || 0,
        tradeSide: d.tradeSide,
        dealStatus: d.dealStatus,
        commission: (d.commission || 0) / 100,
        executionTimestamp: d.executionTimestamp,
        closePositionDetail: d.closePositionDetail ? {
          entryPrice: d.closePositionDetail.entryPrice || 0,
          profit: (d.closePositionDetail.profit || 0) / 100,
          swap: (d.closePositionDetail.swap || 0) / 100,
          commission: (d.closePositionDetail.commission || 0) / 100,
          balance: (d.closePositionDetail.balance || 0) / 100,
          closedVolume: d.closePositionDetail.closedVolume || 0,
        } : null,
      }));
    } catch (err: any) {
      if (err.message?.includes("UNSUPPORTED_MESSAGE") || err.message?.includes("Unsupported payloadType")) {
        console.warn("[cTrader] Deal history not supported on this server — disabling future requests");
        this._dealHistorySupported = false;
      } else {
        console.error("[cTrader] getDealHistory error:", err.message);
      }
      return [];
    }
  }

  async amendPositionSLTP(positionId: number, stopLoss?: number, takeProfit?: number): Promise<any> {
    const fields: any = {
      ctidTraderAccountId: this.config.accountId,
      positionId,
    };
    if (stopLoss !== undefined) {
      if (isNaN(stopLoss) || stopLoss <= 0) {
        throw new Error(`Invalid SL for amend: ${stopLoss}`);
      }
      fields.stopLoss = stopLoss;
    }
    if (takeProfit !== undefined) {
      if (isNaN(takeProfit) || takeProfit <= 0) {
        throw new Error(`Invalid TP for amend: ${takeProfit}`);
      }
      fields.takeProfit = takeProfit;
    }
    console.log(`[cTrader] Amending position ${positionId}: SL=${stopLoss ?? 'unchanged'} TP=${takeProfit ?? 'unchanged'}`);

    const res = await this.sendAndWait(ProtoOAPayloadType.AMEND_POSITION_SLTP_REQ, fields);
    return res;
  }

  getStatus(): {
    connected: boolean;
    authenticated: boolean;
    accountAuthed: boolean;
    positions: Position[];
    lastSpot: SpotPrice | null;
    symbolId: number;
    balance: number | null;
    leverage: number | null;
  } {
    return {
      connected: this.connected,
      authenticated: this.authenticated,
      accountAuthed: this.accountAuthed,
      positions: this.currentPositions,
      lastSpot: this.lastSpot,
      symbolId: this.xauSymbolId,
      balance: this._balance,
      leverage: this._leverage,
    };
  }
}
