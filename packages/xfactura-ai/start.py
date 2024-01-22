from xfactura_ro.server import app



if __name__ == '__main__':
    from waitress import serve
    port = 8080
    print("Starting server on port %s" % port)
    serve(app, host='0.0.0.0', port=port)
