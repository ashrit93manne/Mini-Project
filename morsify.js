var m = require('./alphabet.js');
var b = require('bonescript');
var app = require('http').createServer(handler);
var io = require('socket.io').listen(app);
var fs= require('fs');
var ledPin = "P8_13";
var mString = "welcome";
var state = b.LOW;
var ps=100; // 20 en iyi değer, 100 normal değer
app.listen(9090);


b.pinMode(ledPin, b.OUTPUT);
b.digitalWrite(ledPin, state);

toggle(mString);

function handler(req,res){
 fs.readFile('index.html',
    function(err,data){
        if(err){
            res.writeHead(500);
            return res.end('500.html');
        }
        
        res.writeHead(200);
        res.end(data);
    });
}
    
    
    
io.sockets.on('connection',function(socket){
    socket.on('sendval',function(data){
        console.log("Socket :" + socket);
        console.log("Request :" + data);
        toggle(data.toLowerCase());
        //socket.emit('datastatus','sent');
        //socket.broadcast.emit('dataupdate','ok);
    });
});

function toggle(mstring) {
    
    for(var i = 0;i<mstring.length;i++){
        var letter = mstring.charAt(i);
        var mors= m.getMorse(letter);
        //io.sockets.socket.write(letter);
        for(var j = 0; j < mors.length;j++){
        
            console.log(letter + "["+j+"]:" +mors);
            switch (mors.charAt(j)){
                case "0":
                    b.digitalWrite(ledPin,b.HIGH);
                    waitabit(ps);
                    break;
                case "1":
                    b.digitalWrite(ledPin,b.HIGH);
                    waitabit(ps*3);
                    break;
                case "2":
                    waitabit(ps);
                    break;
                default:
                    break;
            }
            
        //parlama araları
        b.digitalWrite(ledPin,b.LOW);
        waitabit(ps);
        }
        //harf araları
        waitabit(ps*3);
        b.digitalWrite(ledPin,b.LOW);
    }
    
    b.digitalWrite(ledPin, b.LOW);
}
function waitabit (bit){
    var startTime = new Date().getTime();
    while (new Date().getTime() < startTime + bit);
}