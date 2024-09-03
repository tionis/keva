package main

import (
	"database/sql"
	"github.com/gin-gonic/gin"
	"net/http"
)

type entry struct {
	data         interface{}
	versionstamp int
}

type entryUpdate struct {
	path  string
	entry entry
}

type db struct {
	db           *sql.DB
	channels     map[string]chan entry // updates to the database are sent here via sqlite trigger + update func
	entryUpdates chan entryUpdate      // all updates land here to be able to watch patterns
}

func handleRest(c *gin.Context, db db) {
	path := c.Param("path")
	method := c.Request.Method
	c.JSON(http.StatusOK, gin.H{
		"path":   path,
		"method": method,
	})
}

func handleWatch(c *gin.Context, db db) {
	// TODO also allow watching patterns using some
	var paths []string
	c.BindJSON(&paths)
	c.JSON(http.StatusOK, gin.H{
		"paths": paths,
	})
}

func main() {
	db := db{
		db:       nil,
		channels: make(map[string]chan entry),
	}
	r := gin.Default()
	r.Any("/rest/*path", func(c *gin.Context) {
		handleRest(c, db)
	})
	r.Any("/r/*path", func(c *gin.Context) {
		handleRest(c, db)
	})
	r.POST("/api/watch", func(c *gin.Context) {
		handleWatch(c, db)
	})
	r.POST("/watch", func(c *gin.Context) {
		handleWatch(c, db)
	})
	// TODO start mqtt server for pubsub thingies

	r.Run("0.0.0.0:8080")
}
