######## Preamble Section ########
import connmod
import uniInputMapping

import math

HWST = None
HWRT = None
P1Amps = None
P2Amps = None
OAT = None
SysOn = None
HWSP = None
PumpOvr = None
P1Fault = None
P2Fault = None
LeadPump = None
FailTmr = None
LeadAmps = None
Swap = None
LagAmps = None
P1On = None
BlrOvr = None
LeadFlt = None
P2On = None
LagFlt = None
SwapTmr = None
B1Lock = None
i = None
B2Lock = None
DTTmr = None
ProveTmr = None
RunTmr = None
Stage = None
LeadBlr = None
LeadLock = None
LagLock = None
BlrRun = None
MaxStg = None
S1 = None
DnTmr = None
UpTmr = None
S2 = None
T = None


def runStartup():
  global HWST, HWRT, P1Amps, P2Amps, OAT, SysOn, HWSP, PumpOvr, P1Fault, P2Fault, LeadPump, FailTmr, LeadAmps, Swap, LagAmps, P1On, BlrOvr, LeadFlt, P2On, LagFlt, SwapTmr, B1Lock, i, B2Lock, DTTmr, ProveTmr, RunTmr, Stage, LeadBlr, LeadLock, LagLock, BlrRun, MaxStg, S1, DnTmr, UpTmr, S2, T
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40000)
  connmod.WriteDataTypeRegister(1,1, 40000, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40002)
  connmod.WriteDataTypeRegister(1,1, 40002, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40004)
  connmod.WriteDataTypeRegister(1,1, 40004, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40006)
  connmod.WriteDataTypeRegister(1,1, 40006, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40008)
  connmod.WriteDataTypeRegister(1,1, 40008, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40010)
  connmod.WriteDataTypeRegister(1,1, 40010, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40012)
  connmod.WriteDataTypeRegister(1,1, 40012, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40014)
  connmod.WriteDataTypeRegister(1,1, 40014, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40016)
  connmod.WriteDataTypeRegister(1,1, 40016, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40018)
  connmod.WriteDataTypeRegister(1,1, 40018, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40020)
  connmod.WriteDataTypeRegister(1,1, 40020, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40022)
  connmod.WriteDataTypeRegister(1,1, 40022, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40024)
  connmod.WriteDataTypeRegister(1,1, 40024, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40026)
  connmod.WriteDataTypeRegister(1,1, 40026, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40028)
  connmod.WriteDataTypeRegister(1,1, 40028, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40030)
  connmod.WriteDataTypeRegister(1,1, 40030, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40032)
  connmod.WriteDataTypeRegister(1,1, 40032, 1)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40034)
  connmod.WriteDataTypeRegister(1,1, 40034, 1)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40036)
  connmod.WriteDataTypeRegister(1,1, 40036, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40038)
  connmod.WriteDataTypeRegister(1,1, 40038, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40040)
  connmod.WriteDataTypeRegister(1,1, 40040, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40042)
  connmod.WriteDataTypeRegister(1,1, 40042, 0)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40044)
  connmod.WriteDataTypeRegister(1,1, 40044, 1)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40046)
  connmod.WriteDataTypeRegister(1,1, 40046, 15)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40048)
  connmod.WriteDataTypeRegister(1,1, 40048, 70)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40050)
  connmod.WriteDataTypeRegister(1,1, 40050, 85)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40052)
  connmod.WriteDataTypeRegister(1,1, 40052, 3)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40054)
  connmod.WriteDataTypeRegister(1,1, 40054, 3)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40056)
  connmod.WriteDataTypeRegister(1,1, 40056, 10)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40058)
  connmod.WriteDataTypeRegister(1,1, 40058, 10)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40060)
  connmod.WriteDataTypeRegister(1,1, 40060, 7)
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40062)
  connmod.WriteDataTypeRegister(1,1, 40062, 30)
  connmod.ConfigureHomeScreenInput(0, 'Hot Water Supply Temp', '°C')
  connmod.UpdateHomeScreenInput(0, 0)
  connmod.ConfigureHomeScreenInput(1, 'Hot Water Return Temp', '°C')
  connmod.UpdateHomeScreenInput(1, 0)
  connmod.ConfigureHomeScreenInput(2, 'Pump 1 Status', '')
  connmod.UpdateHomeScreenInput(2, 'Off')
  connmod.ConfigureHomeScreenInput(3, 'Pump 2 Status', '')
  connmod.UpdateHomeScreenInput(3, 'Off')
  connmod.ConfigureHomeScreenInput(4, 'Boiler 1 Low Fire', '')
  connmod.UpdateHomeScreenInput(4, 'Disabled')
  connmod.ConfigureHomeScreenInput(5, 'Boiler 1 High Fire', '')
  connmod.UpdateHomeScreenInput(5, 'Disabled')
  connmod.ConfigureHomeScreenInput(6, 'Boiler 2 Low Fire', '')
  connmod.UpdateHomeScreenInput(6, 'Disabled')
  connmod.ConfigureHomeScreenInput(7, 'Boiler 2 High Fire', '')
  connmod.UpdateHomeScreenInput(7, 'Disabled')
  connmod.SetUniversalInputMode(0, 1)
  connmod.SetUniversalInputMode(1, 1)
  connmod.SetUniversalInputMode(2, 0)
  connmod.SetUniversalInputMode(3, 0)
  connmod.SetUniversalInputMode(4, 1)
  connmod.SetUniversalInputMode(5, 0)
  for i in range(8):
    connmod.SetRelayOutput(i, 0)
  for i in range(4):
    connmod.SetAnalogOutput(i, 0)
  SysOn = 0
  LeadPump = 1
  P1On = 0
  P2On = 0
  P1Fault = 0
  P2Fault = 0
  FailTmr = 0
  RunTmr = 0
  Swap = 0
  SwapTmr = 0
  ProveTmr = 0
  LeadBlr = 1
  Stage = 0
  UpTmr = 0
  DnTmr = 0
  B1Lock = 0
  B2Lock = 0
  DTTmr = 0
  BlrRun = 0


def runContinuous():
  global HWST, HWRT, P1Amps, P2Amps, OAT, SysOn, HWSP, PumpOvr, P1Fault, P2Fault, LeadPump, FailTmr, LeadAmps, Swap, LagAmps, P1On, BlrOvr, LeadFlt, P2On, LagFlt, SwapTmr, B1Lock, i, B2Lock, DTTmr, ProveTmr, RunTmr, Stage, LeadBlr, LeadLock, LagLock, BlrRun, MaxStg, S1, DnTmr, UpTmr, S2, T
  HWST = round(((uniInputMapping.ConvertValueFromIndex(connmod.GetUniversalInputValue(0), 28) - 32) * (5 / 9)) * 100) / 100
  HWRT = round(((uniInputMapping.ConvertValueFromIndex(connmod.GetUniversalInputValue(1), 28) - 32) * (5 / 9)) * 100) / 100
  P1Amps = round(uniInputMapping.ConvertValueFromIndex(connmod.GetUniversalInputValue(2), 42) * 100) / 100
  P2Amps = round(uniInputMapping.ConvertValueFromIndex(connmod.GetUniversalInputValue(3), 42) * 100) / 100
  OAT = round(((uniInputMapping.ConvertValueFromIndex(connmod.GetUniversalInputValue(4), 28) - 32) * (5 / 9)) * 100) / 100
  if SysOn == 0 and OAT < connmod.ReadDataTypeRegister(1,1, 40046):
    SysOn = 1
  elif SysOn == 1 and OAT > connmod.ReadDataTypeRegister(1,1, 40046) + 2:
    SysOn = 0
  if OAT <= 0:
    HWSP = connmod.ReadDataTypeRegister(1,1, 40050)
  elif OAT >= 15:
    HWSP = connmod.ReadDataTypeRegister(1,1, 40048)
  else:
    HWSP = connmod.ReadDataTypeRegister(1,1, 40050) - OAT * ((connmod.ReadDataTypeRegister(1,1, 40050) - connmod.ReadDataTypeRegister(1,1, 40048)) / 15)
  PumpOvr = connmod.ReadDataTypeRegister(1,1, 40024)
  if connmod.ReadDataTypeRegister(1,1, 40030) == 1:
    P1Fault = 0
    P2Fault = 0
    FailTmr = 0
    Swap = 0
  if PumpOvr == 1:
    LeadPump = 1
  elif PumpOvr == 2:
    LeadPump = 2
  if LeadPump == 1:
    LeadAmps = P1Amps
    LagAmps = P2Amps
    LeadFlt = P1Fault
    LagFlt = P2Fault
  else:
    LeadAmps = P2Amps
    LagAmps = P1Amps
    LeadFlt = P2Fault
    LagFlt = P1Fault
  if SysOn == 0 or PumpOvr == 3:
    P1On = 0
    P2On = 0
    Swap = 0
    FailTmr = 0
  elif Swap == 1 and PumpOvr == 0:
    P1On = 1
    P2On = 1
    SwapTmr = SwapTmr + 1
    if LagAmps > 0.25:
      ProveTmr = ProveTmr + 1
    else:
      ProveTmr = 0
    if ProveTmr > 12:
      LeadPump = 3 - LeadPump
      Swap = 0
      RunTmr = 0
      FailTmr = 0
    elif SwapTmr > 18:
      if LeadPump == 1:
        P2Fault = 1
      else:
        P1Fault = 1
      Swap = 0
      RunTmr = 0
  else:
    Swap = 0
    if PumpOvr == 0:
      if LeadAmps > 0.25:
        FailTmr = 0
        RunTmr = RunTmr + 1
      else:
        FailTmr = FailTmr + 1
      if FailTmr > 6:
        if LeadPump == 1:
          P1Fault = 1
        else:
          P2Fault = 1
        LeadFlt = 1
        FailTmr = 0
      if LeadFlt == 1 and LagFlt == 0:
        LeadPump = 3 - LeadPump
        RunTmr = 0
        FailTmr = 0
      elif RunTmr >= connmod.ReadDataTypeRegister(1,1, 40060) * 8640 and LagFlt == 0:
        Swap = 1
        SwapTmr = 0
        ProveTmr = 0
    if P1Fault == 1 and P2Fault == 1:
      P1On = 0
      P2On = 0
    elif LeadPump == 1:
      P1On = 1
      P2On = 0
    else:
      P1On = 0
      P2On = 1
  BlrOvr = connmod.ReadDataTypeRegister(1,1, 40026)
  if connmod.ReadDataTypeRegister(1,1, 40028) == 1:
    B1Lock = 0
    B2Lock = 0
    DTTmr = 0
  if Stage >= 2 and HWST - HWRT < 5:
    DTTmr = DTTmr + 1
  else:
    DTTmr = 0
  if DTTmr > 360:
    if LeadBlr == 1:
      B1Lock = 1
    else:
      B2Lock = 1
    DTTmr = 0
  if BlrOvr == 1:
    LeadBlr = 1
  elif BlrOvr == 2:
    LeadBlr = 2
  if LeadBlr == 1:
    LeadLock = B1Lock
    LagLock = B2Lock
  else:
    LeadLock = B2Lock
    LagLock = B1Lock
  if Stage > 0:
    BlrRun = BlrRun + 1
  if LeadLock == 1 and LagLock == 0:
    LeadBlr = 3 - LeadBlr
    LeadLock = 0
    LagLock = 1
    BlrRun = 0
  elif BlrOvr == 0 and LagLock == 0 and BlrRun >= connmod.ReadDataTypeRegister(1,1, 40062) * 8640:
    LeadBlr = 3 - LeadBlr
    BlrRun = 0
  if LeadLock == 1:
    MaxStg = 0
  elif LagLock == 1 or connmod.ReadDataTypeRegister(1,1, 40044) == 1:
    MaxStg = 2
  else:
    MaxStg = 4
  if SysOn == 1 and BlrOvr != 3 and (P1Amps > 0.25 or P2Amps > 0.25):
    if HWST < HWSP - connmod.ReadDataTypeRegister(1,1, 40052):
      DnTmr = 0
      UpTmr = UpTmr + 1
    elif HWST > HWSP + connmod.ReadDataTypeRegister(1,1, 40054):
      UpTmr = 0
      DnTmr = DnTmr + 1
    else:
      UpTmr = 0
      DnTmr = 0
    if UpTmr >= connmod.ReadDataTypeRegister(1,1, 40056) and Stage < MaxStg:
      Stage = Stage + 1
      UpTmr = 0
    if DnTmr >= connmod.ReadDataTypeRegister(1,1, 40058) and Stage > 0:
      Stage = Stage - 1
      DnTmr = 0
    if Stage > MaxStg:
      Stage = MaxStg
  else:
    Stage = 0
    UpTmr = 0
    DnTmr = 0
  S1 = Stage
  if Stage > 2:
    S1 = 2
  S2 = Stage - S1
  if LeadBlr == 2:
    T = S1
    S1 = S2
    S2 = T
  connmod.SetRelayOutput(0, P1On)
  connmod.SetRelayOutput(1, P2On)
  if S1 >= 1:
    T = 1
    connmod.UpdateHomeScreenInput(4, 'Enabled')
  else:
    T = 0
    connmod.UpdateHomeScreenInput(4, 'Disabled')
  connmod.SetRelayOutput(4, T)

  connmod.WriteDataTypeRegister(1,1, 40020, T)
  if S1 >= 2:
    T = 1
    connmod.UpdateHomeScreenInput(5, 'Enabled')
  else:
    T = 0
    connmod.UpdateHomeScreenInput(5, 'Disabled')
  connmod.SetRelayOutput(2, T)

  connmod.WriteDataTypeRegister(1,1, 40016, T)
  if S2 >= 1:
    T = 1
    connmod.UpdateHomeScreenInput(6, 'Enabled')
  else:
    T = 0
    connmod.UpdateHomeScreenInput(6, 'Disabled')
  connmod.SetRelayOutput(5, T)

  connmod.WriteDataTypeRegister(1,1, 40022, T)
  if S2 >= 2:
    T = 1
    connmod.UpdateHomeScreenInput(7, 'Enabled')
  else:
    T = 0
    connmod.UpdateHomeScreenInput(7, 'Disabled')
  connmod.SetRelayOutput(3, T)

  connmod.WriteDataTypeRegister(1,1, 40018, T)
  connmod.UpdateHomeScreenInput(0, HWST)
  connmod.UpdateHomeScreenInput(1, HWRT)
  connmod.UpdateHomeScreenInput(2, P1Amps)
  connmod.UpdateHomeScreenInput(3, P2Amps)

  connmod.WriteDataTypeRegister(1,1, 40000, (round(uniInputMapping.ConvertValueFromIndex(connmod.GetUniversalInputValue(5), 86))))

  connmod.WriteDataTypeRegister(1,1, 40002, OAT)

  connmod.WriteDataTypeRegister(1,1, 40004, HWST)

  connmod.WriteDataTypeRegister(1,1, 40006, HWRT)

  connmod.WriteDataTypeRegister(1,1, 40008, P1Amps)

  connmod.WriteDataTypeRegister(1,1, 40010, P2Amps)

  connmod.WriteDataTypeRegister(1,1, 40012, P1On)

  connmod.WriteDataTypeRegister(1,1, 40014, P2On)

  connmod.WriteDataTypeRegister(1,1, 40032, LeadBlr)

  connmod.WriteDataTypeRegister(1,1, 40034, LeadPump)

  connmod.WriteDataTypeRegister(1,1, 40036, P1Fault)

  connmod.WriteDataTypeRegister(1,1, 40038, P2Fault)

  connmod.WriteDataTypeRegister(1,1, 40040, B1Lock)

  connmod.WriteDataTypeRegister(1,1, 40042, B2Lock)

######## Superloop Section ########
connmod.EnterSequence()
runStartup()
connmod.ExitSequence()
while True:
  connmod.DelayMs(10000)
  connmod.EnterSequence()
  runContinuous()
  connmod.ExitSequence()