-- Location: ServerStorage/ZeroBurnAIPlugin

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ZBGuiObjects = require(script:WaitForChild("ZBGuiObjects"))
local ZBColorMap = require(script:WaitForChild("ZBColorMap"))
local ZBActions = require(script:WaitForChild("ZBActions"))

if not plugin then return end