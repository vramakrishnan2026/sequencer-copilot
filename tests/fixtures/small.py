######## Preamble Section ########
import connmod
import uniInputMapping

CO2 = None
H2 = None


def runStartup():
  global CO2, H2
  connmod.ConfigureCustomDatatypeModbusRegister(1,1, 40000)
  connmod.SetUniversalInputMode(0, 0)
  connmod.ConfigureHomeScreenInput(0, 'H2', '%')
  connmod.UpdateHomeScreenInput(0, 0)
  connmod.ConfigureHomeScreenInput(1, 'CO2', 'ppm')
  connmod.UpdateHomeScreenInput(1, 0)


def runContinuous():
  global CO2, H2
  H2 = uniInputMapping.ScaleValue(connmod.GetUniversalInputValue(0), 4, 20, 0, 100)
  CO2 = connmod.GetSensorBusValue(2, 2)
  connmod.UpdateHomeScreenInput(0, H2)
  connmod.UpdateHomeScreenInput(1, CO2)
  if H2 > 5 and CO2 > 900:
    connmod.SetRelayOutput(0, 1)
    connmod.SetAnalogOutput(0, 4)
  else:
    connmod.SetRelayOutput(0, 0)
    connmod.SetAnalogOutput(0, 0)


CO2

1

0

######## Superloop Section ########
connmod.EnterSequence()
runStartup()
connmod.ExitSequence()
while True:
  connmod.DelayMs(1000)
  connmod.EnterSequence()
  runContinuous()
  connmod.ExitSequence()
