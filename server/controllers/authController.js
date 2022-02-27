const UserModel = require("../models/user")
const { BadRequestError, UnauthenticatedError } = require("../errors")
const EC = require("elliptic").ec
const ec = new EC("secp256k1")

const generateKeys = async (req, res) => {
  const key = ec.genKeyPair()
  const publicKey = key.getPublic("hex")
  const privateKey = key.getPrivate("hex")
  res.status(200).json({ publicKey, privateKey })
}

const register = async (req, res) => {
  const user = await UserModel.create({ ...req.body })

  // to do: check if user already exists in database

  const token = user.createJWT()
  res.status(201).json({ user: { name: user.username }, token })
}

const login = async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    throw new BadRequestError("Please provide email and password")
  }

  const user = await UserModel.findOne({ username })

  if (!user) {
    throw new BadRequestError("Invalid credentials")
  }

  const isPasswordCorrect = await user.comparePassword(password)
  if (!isPasswordCorrect) {
    throw new BadRequestError("Invalid credentials")
  }

  const token = user.createJWT()
  res.status(200).json({ user: { name: user.username }, token })
}

module.exports = {
  register,
  login,
  generateKeys,
}