const express = require('express')
const app = express()
require('dotenv').config()
const cors = require('cors')
const cookieParser = require('cookie-parser')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const jwt = require('jsonwebtoken')
const morgan = require('morgan')
const port = process.env.PORT || 5000
const stripe = require('stripe')(process.env.SECRET_PAYMENT_KEY)

// middleware
const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
  optionSuccessStatus: 200,
}
app.use(cors(corsOptions))
app.use(express.json())
app.use(cookieParser())
app.use(morgan('dev'))


const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token
  console.log(token)
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err)
      return res.status(401).send({ message: 'unauthorized access' })
    }
    req.user = decoded
    next()
  })
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wwbu2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {
    await client.connect();
    const usersCollection = client.db('vistaDB').collection('users');
    const roomsCollection = client.db('vistaDB').collection('rooms');
    const bookingsCollection = client.db('vistaDB').collection('bookings');

    // role verification middleware
    // for admin
    const verifyAdmin = async(req, res, next) =>{
      const user = req.user;
      const query = {email: user?.email};
      const result = await usersCollection.findOne(query);
      if(!result || result?.role !== 'admin') return res.status(401).send({message: 'unauthorized access'})
      next();
    }

    // for host
    const verifyHost = async(req, res, next) =>{
      const user = req.user;
      const query = {email: user?.email};
      const result = await usersCollection.findOne(query);
      if(!result || result?.role !== 'host') return res.status(401).send({message: 'unauthorized access'})
      next();
    }

    // auth related api
    app.post('/jwt', async (req, res) => {
      const user = req.body
      console.log('I need a new jwt', user)
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '365d',
      })
      res
        .cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
        })
        .send({ success: true })
    })

    // Logout
    app.get('/logout', async (req, res) => {
      try {
        res
          .clearCookie('token', {
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
          })
          .send({ success: true })
        console.log('Logout successful')
      } catch (err) {
        res.status(500).send(err)
      }
    })

    // Save or modify a new user's email, status in DB
    app.put('/users/:email', async (req, res) => {
      const email = req.params.email
      const user = req.body
      const query = { email: email }
      const options = { upsert: true }
      const isExist = await usersCollection.findOne(query)
      console.log('User found?----->', isExist)
      if (isExist){
        if(user.status === 'requested'){
          const result = await usersCollection.updateOne(
            query,
            {
               $set: user
            },
            options
          )
          return res.send(result);
        }else{
          return res.send(isExist)
        }
      }
      const result = await usersCollection.updateOne(
        query,
        {
          $set: { ...user, timestamp: Date.now() },
        },
        options
      )
      res.send(result);
    });

    app.get('/user/:email', async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    })

    // get all rooms 
    app.get('/rooms', async (req, res) => {
      const result = await roomsCollection.find().toArray();
      res.send(result);
    });

    // get rooms for specific host
    app.get('/rooms/:email', async (req, res) => {
      const email = req.params.email;
      const query = { 'host.email': email }; //this is the way(quotation) when the field is in a object in db
      const result = await roomsCollection.find(query).toArray();
      res.send(result);
    });

    // get single room
    app.get('/room/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await roomsCollection.findOne(query);
      res.send(result);
    });

    // add room to database
    app.post('/rooms', verifyToken, async (req, res) => {
      const roomData = req.body;
      const result = await roomsCollection.insertOne(roomData);
      res.send(result);
    })

    // stripe client secret key
    app.post('/create-payment-intent', verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      if (!price || amount < 1) return;
      const { client_secret } = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card']
      });
      res.send({ clientSecret: client_secret });
    })

    // save booking info to db
    app.post('/bookings', verifyToken, async (req, res) => {
      const booking = req.body;
      const result = await bookingsCollection.insertOne(booking);
      // send email
      res.send(result);
    })

    // update room booking status
    app.patch('/rooms/status/:id', async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          booked: status
        }
      };
      const result = await roomsCollection.updateOne(query, updateDoc);
      res.send(result);
    })

    // get all booking for guest
    app.get('/bookings', verifyToken, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.send([]);
      const query = { 'guest.email': email };
      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    })

    // get all bookings for host
    app.get('/bookings/host', verifyToken, verifyHost, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.send([]);
      const query = { host: email };
      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    })

    // get all users
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    })

    // update user role
    app.put('/users/update/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now()
        }
      };
      const result = await usersCollection.updateOne(query, updateDoc, options);
      res.send(result);
    })

    // Admin Statistics
    app.get('/admin-stat', verifyToken, verifyAdmin, async (req, res) => {
      const bookingDetails = await bookingsCollection
        .find(
          {},
          {
            projection: {
              date: 1,
              price: 1,
            },
          }
        )
        .toArray()

      const totalUsers = await usersCollection.countDocuments()
      const totalRooms = await roomsCollection.countDocuments()
      const totalPrice = bookingDetails.reduce(
        (sum, booking) => sum + booking.price,
        0
      )
      // const data = [
      //   ['Day', 'Sales'],
      //   ['9/5', 1000],
      //   ['10/2', 1170],
      //   ['11/1', 660],
      //   ['12/11', 1030],
      // ]
      const chartData = bookingDetails.map(booking => {
        const day = new Date(booking.date).getDate()
        const month = new Date(booking.date).getMonth() + 1
        const data = [`${day}/${month}`, booking?.price]
        return data
      })
      chartData.unshift(['Day', 'Sales'])
      // chartData.splice(0, 0, ['Day', 'Sales'])

      console.log(chartData)

      console.log(bookingDetails)
      res.send({
        totalUsers,
        totalRooms,
        totalBookings: bookingDetails.length,
        totalPrice,
        chartData,
      })
    })

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from StayVista Server..')
})

app.listen(port, () => {
  console.log(`StayVista is running on port ${port}`)
})