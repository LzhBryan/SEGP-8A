const BlockModel = require("../models/block")
const UserModel = require("../models/user")
const TransactionModel = require("../models/transaction")
const {
  computeTransactionHash,
  checkTransactionValidity,
} = require("../controllers/transactionController")
const { NotFoundError, BadRequestError } = require("../errors")
const CONSENSUS_THRESHOLD = 0.66
const GENESIS_BLOCK_ID = 0
const MAX_RECORD = 2
const { createHash } = require("crypto")

const getBlockchain = async (req, res) => {
  let blockchain = await BlockModel.find({ status: "inChain" })
  if (blockchain.length == 0) {
    blockchain = await createGenesisBlock()
    await createHibernateBlock()
  }
  res.status(200).json({ blockchain })
}

const getBlock = async (req, res) => {
  const { id: blockID } = req.params
  const block = await BlockModel.findOne({ blockId: blockID })
  if (!block) {
    throw new NotFoundError(`No block with block id ${blockID}`)
  }
  res.status(200).json({ block })
}

const getHibernateBlock = async (req, res) => {
  const hibernateBlock = await BlockModel.findOne({ status: "Hibernating" })
  res.status(200).json({ hibernateBlock })
}

const activateBlock = async (req, res) => {
  const { id: blockID } = req.params

  const selectedBlock = await BlockModel.findOne({
    _id: blockID,
    status: "Hibernating",
  })

  if (!selectedBlock) {
    throw new NotFoundError(
      `No block with id ${blockID} or block has already been activated`
    )
  }

  const isMaxRecord = selectedBlock.records.length === MAX_RECORD
  if (!isMaxRecord) {
    throw new BadRequestError("Insufficient records in this block")
  }

  const activateBlock = await BlockModel.findOneAndUpdate(
    { _id: blockID },
    {
      status: "Pending",
      timestamp: new Date().toLocaleString("en-GB"),
    },
    { new: true }
  )
  res.status(200).json({ msg: `Block ${blockID} is activated`, activateBlock })
}

const validateBlock = async (req, res) => {
  const { id: blockID } = req.params

  const block = await BlockModel.findOne({
    _id: blockID,
  })

  if (!block) {
    throw new BadRequestError(`No block with id ${blockID}`)
  }

  isValid = validateBlockRecords(block.records)

  res.status(200).json({ isValid })
}

const approveBlock = async (req, res) => {
  const { id: blockID } = req.params
  const { isApproved } = req.body
  const { username } = req.user

  const hasApproveBefore = await BlockModel.findOne({
    $and: [
      { _id: blockID },
      { $or: [{ approvedBy: username }, { rejectedBy: username }] },
    ],
  })

  if (hasApproveBefore) {
    throw new BadRequestError("Already rejected or approved this block")
  }

  let block = await BlockModel.findOneAndUpdate(
    { _id: blockID, status: "Pending" },
    {
      $addToSet: isApproved
        ? { approvedBy: username }
        : { rejectedBy: username },
    },
    { new: true }
  )

  if (!block) {
    throw new NotFoundError(
      `No pending block with id ${blockID} or block has not been activated`
    )
  }

  block = await blockConsensus(block, blockID)

  let message
  isApproved
    ? (message = "You have approved this block")
    : (message = "You have rejected this block")

  res.status(200).json({ message: message, block })
}

async function createGenesisBlock() {
  const previousHash = ""
  const timestamp = new Date().toLocaleString("en-GB")
  const record = ""
  const genesisBlock = await BlockModel.create({
    blockId: GENESIS_BLOCK_ID,
    prevHash: previousHash,
    hash: computeBlockHash(GENESIS_BLOCK_ID, previousHash, timestamp, record),
    timestamp: timestamp,
    status: "inChain",
  })
  return genesisBlock
}

async function createHibernateBlock() {
  let hibernateBlock = await BlockModel.create({
    timestamp: new Date().toLocaleString("en-GB"),
  })

  const waitingTransactions = await TransactionModel.find({
    status: "Approved",
  })

  if (waitingTransactions.length > MAX_RECORD) {
    for (i = 0; i < MAX_RECORD; i++) {
      waitingTransactions[i].status = "inBlock"
      await waitingTransactions[i].save()
    }
    hibernateBlock = await BlockModel.findOneAndUpdate(
      { status: "Hibernating" },
      { records: waitingTransactions.slice(0, MAX_RECORD) },
      { new: true }
    )
  } else {
    for (i = 0; i < waitingTransactions.length; i++) {
      waitingTransactions[i].status = "inBlock"
      await waitingTransactions[i].save()
    }
    hibernateBlock = await BlockModel.findOneAndUpdate(
      { status: "Hibernating" },
      { records: waitingTransactions },
      { new: true }
    )
  }
  return hibernateBlock
}

function computeBlockHash(blockId, prevHash, timestamp, record) {
  return createHash("sha256")
    .update(blockId.toString() + prevHash + timestamp + JSON.stringify(record))
    .digest("hex")
}

async function blockConsensus(block, id) {
  if (block.status === "Pending") {
    const validators = await UserModel.find({ role: "Validator" })

    const approvedPercentage =
      block.approvedBy.length / parseFloat(validators.length)

    const rejectedPercentage =
      block.rejectedBy.length / parseFloat(validators.length)

    if (approvedPercentage >= CONSENSUS_THRESHOLD) {
      block = await BlockModel.findOneAndUpdate(
        { _id: id },
        { status: "Approved" },
        { new: true }
      )
      await updateRecordsStatus()
      await updateRecordsStatusInBlock(block)
      block = await appendToBlockchain(block, id)
    } else if (rejectedPercentage >= CONSENSUS_THRESHOLD) {
      block = await BlockModel.findOneAndUpdate(
        { _id: id },
        { status: "Rejected", timestamp: new Date().toLocaleString("en-GB") },
        { new: true }
      )
      await rejectRecords()
      await rejectRecordsStatusInBlock(block)
      await createHibernateBlock()
    }
    return block
  }
}

async function appendToBlockchain(block, id) {
  const blockchain = await BlockModel.find({ status: "inChain" }).sort({
    blockId: -1,
  })
  const blockId = blockchain[0].blockId + 1
  const prevHash = blockchain[0].hash
  const timestamp = new Date().toLocaleString("en-GB")
  const updatedBlock = await BlockModel.findOneAndUpdate(
    { _id: id, status: "Approved" },
    {
      blockId: blockId,
      prevHash: prevHash,
      hash: computeBlockHash(blockId, prevHash, timestamp, block.records),
      timestamp,
      status: "inChain",
    },
    { new: true }
  )
  await createHibernateBlock()
  return updatedBlock
}

async function updateRecordsStatus() {
  await TransactionModel.updateMany(
    { status: "inBlock" },
    { status: "inChain" }
  )
}

async function rejectRecords() {
  await TransactionModel.updateMany(
    { status: "inBlock" },
    { status: "Rejected" }
  )
}

async function updateRecordsStatusInBlock(block) {
  for (i = 0; i < MAX_RECORD; i++) {
    block.records[i].status = "inChain"
  }
  block.markModified("records")
  await block.save()
}

async function rejectRecordsStatusInBlock(block) {
  for (i = 0; i < MAX_RECORD; i++) {
    block.records[i].status = "Rejected"
  }
  block.markModified("records")
  await block.save()
}

function validateBlockRecords(records) {
  for (record of records) {
    if ("amount" in record) {
      if (!checkTransactionValidity(record)) {
        return false
      }
    }
  }
  return true
}

function validateBlockchain(blockchain) {
  for (let i = 1; i < blockchain.length; i++) {
    const currentBlock = blockchain[i]
    const prevBlock = this.chain[i - 1]

    if (currentBlock.hash !== computeBlockHash(currentBlock.blockId)) {
      return false
    }

    if (currentBlock.prevHash !== prevBlock.hash) {
      return false
    }

    if (!currentBlock.hasValidTransactions()) {
      return false
    }
  }
  return true
}

module.exports = {
  getBlockchain,
  getBlock,
  getHibernateBlock,
  validateBlock,
  activateBlock,
  approveBlock,
}
